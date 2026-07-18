/**
 * 0001:T2.2 — integration smoke test against the REAL pinned durable-streams
 * server image (`electricax/durable-streams-server-rust:0.1.4`).
 *
 * Skipped unless `TEASPILL_T22_REAL_DS_URL` points at a live server:
 *
 *   docker run --rm -d -p 14438:4437 -e DS_SERVER__PORT=4437 \
 *     electricax/durable-streams-server-rust:0.1.4
 *   TEASPILL_T22_REAL_DS_URL=http://127.0.0.1:14438 \
 *     pnpm --filter @teaspill/coordination test
 *
 * Verifies, against the real server, the exact semantics the property tests
 * assume of the fake: PUT-create idempotence (C3), accept/duplicate/gap/
 * stale-epoch verdict mapping (C4), crash-replay dedup through the real
 * `DurableStreamsProjectionOutbox`, and that the pinned
 * `@durable-streams/client` (0.2.6) can read back what the outbox wrote.
 */

import { describe, expect, it } from "vitest";
import { stream } from "@durable-streams/client";
import { checkSeqContiguity, type TimelineEvent, type TimelineEventInit } from "@teaspill/schema";
import { AGENT_KV, type AgentRuntimeCtx } from "./agent-runtime.js";
import {
  DurableStreamsProjectionOutbox,
  HttpTimelineStreamTransport,
  OUTBOX_KV,
  timelineProducerId,
  timelineStreamPath,
} from "./projection-outbox.js";
import { createNoopOutboxCatalog } from "./projection-catalog.js";

const REAL_DS_URL = process.env.TEASPILL_T22_REAL_DS_URL;

class FakeCtx implements AgentRuntimeCtx {
  readonly key = "i-1";
  readonly invocationId = "inv-1";
  readonly runAbortSignal = new AbortController().signal;
  crashAfterRun = false;
  constructor(private readonly kv: Map<string, unknown>) {}
  async get<T>(name: string): Promise<T | null> {
    return this.kv.has(name) ? (this.kv.get(name) as T) : null;
  }
  set<T>(name: string, value: T): void {
    this.kv.set(name, value);
  }
  clear(name: string): void {
    this.kv.delete(name);
  }
  async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
    const result = await action();
    if (this.crashAfterRun) {
      this.crashAfterRun = false;
      throw new Error("simulated crash after run");
    }
    return result;
  }
  genericSend(): void {}
  raceInterrupt<T>(work: Promise<T>): Promise<T> {
    return work;
  }
}

const TS = "2026-07-17T00:00:00.000Z";
const spawnedInit: TimelineEventInit = {
  type: "entity_spawned",
  ts: TS,
  payload: { entityType: "tester", parentId: null },
};
const messageInit = (n: number): TimelineEventInit => ({
  type: "message",
  ts: TS,
  payload: { id: `m-${n}`, role: "assistant", content: [{ type: "text", text: `event ${n}` }] },
});

/** Unique entity per test run so producer/stream state never collides. */
function freshEntity(): string {
  return `/t/default/a/tester/i-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

describe.skipIf(!REAL_DS_URL)(`REAL durable-streams server at ${REAL_DS_URL ?? "(unset)"}`, () => {
  const transport = () => new HttpTimelineStreamTransport({ baseUrl: REAL_DS_URL! });

  it("PUT-create is idempotent: created then exists (C3)", async () => {
    const t = transport();
    const path = timelineStreamPath(freshEntity());
    expect(await t.createStream(path)).toBe("created");
    expect(await t.createStream(path)).toBe("exists");
  });

  it("producer verdicts map exactly: accept, duplicate, gap, stale epoch, bad epoch start (C4)", async () => {
    const t = transport();
    const entity = freshEntity();
    const path = timelineStreamPath(entity);
    const id = timelineProducerId(entity);
    await t.createStream(path);
    const ev = (seq: number) => JSON.stringify({ probe: seq });

    // unknown producer must start at 0
    expect(await t.appendEvent(path, ev(5), { id, epoch: 0, seq: 5 })).toStrictEqual({
      kind: "gap",
      expectedSeq: 0,
      receivedSeq: 5,
    });
    expect((await t.appendEvent(path, ev(0), { id, epoch: 0, seq: 0 })).kind).toBe("accepted");
    // out-of-order after a gap → rejected with the expected seq
    expect(await t.appendEvent(path, ev(2), { id, epoch: 0, seq: 2 })).toStrictEqual({
      kind: "gap",
      expectedSeq: 1,
      receivedSeq: 2,
    });
    // in-order replay recovers
    expect((await t.appendEvent(path, ev(1), { id, epoch: 0, seq: 1 })).kind).toBe("accepted");
    // duplicate (seq <= last) is a no-op reporting the server's last seq
    expect(await t.appendEvent(path, ev(0), { id, epoch: 0, seq: 0 })).toStrictEqual({
      kind: "duplicate",
      lastSeq: 1,
    });
    // a higher epoch must restart at 0
    expect((await t.appendEvent(path, ev(9), { id, epoch: 1, seq: 9 })).kind).toBe(
      "bad_epoch_start",
    );
    expect((await t.appendEvent(path, ev(0), { id, epoch: 1, seq: 0 })).kind).toBe("accepted");
    // the old epoch is now fenced
    expect(await t.appendEvent(path, ev(2), { id, epoch: 0, seq: 2 })).toStrictEqual({
      kind: "stale_epoch",
      currentEpoch: 1,
    });
    // append to a missing stream → stream_not_found (404)
    expect(
      (
        await t.appendEvent("/t/default/agents/tester/nope/timeline", ev(0), {
          id,
          epoch: 0,
          seq: 0,
        })
      ).kind,
    ).toBe("stream_not_found");
  });

  it("outbox end-to-end: create-on-first-flush, crash replay dedups, client 0.2.6 reads it back", async () => {
    const entity = freshEntity();
    const path = timelineStreamPath(entity);
    const kv = new Map<string, unknown>();
    const catalog = createNoopOutboxCatalog();
    const outbox = new DurableStreamsProjectionOutbox({ transport: transport(), catalog });

    // First flush (stream does not exist yet → 404 → PUT-create → append).
    await outbox.stage(new FakeCtx(kv), entity, [spawnedInit, messageInit(1)]);
    const first = await outbox.flush(new FakeCtx(kv), entity);
    expect(first).toStrictEqual({ appended: 2, headSeq: 1 });

    // Crash between append and trim: effects land, run result lost.
    await outbox.stage(new FakeCtx(kv), entity, [messageInit(2), messageInit(3)]);
    const crashing = new FakeCtx(kv);
    crashing.crashAfterRun = true;
    await expect(outbox.flush(crashing, entity)).rejects.toThrow("simulated crash");
    // Retry: in-order replay from the first unconfirmed → all duplicates.
    const retried = await outbox.flush(new FakeCtx(kv), entity);
    expect(retried).toStrictEqual({ appended: 0, headSeq: 3 });
    expect(kv.get(AGENT_KV.outbox)).toStrictEqual([]);
    expect(kv.get(OUTBOX_KV.confirmedSeq)).toBe(3);
    expect(catalog.upserts[catalog.upserts.length - 1]!.headSeq).toBe(3);

    // Read back through the PINNED CLIENT (interop check): exactly once,
    // in order, gapless.
    const res = await stream<TimelineEvent>({ url: `${REAL_DS_URL}${path}` });
    const events = await res.json();
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3]);
    expect(checkSeqContiguity(events, { expectedFirstSeq: 0 }).ok).toBe(true);
    expect(events[0]!.type).toBe("entity_spawned");
    expect(events.every((e) => e.entityId === entity)).toBe(true);
  });
});
