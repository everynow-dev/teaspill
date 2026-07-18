/**
 * 0001:T2.2 projection outbox — property tests (0001:Gate 3) + unit coverage.
 *
 * The property tests drive the REAL `DurableStreamsProjectionOutbox` against
 * the faithful fake of the durable-streams idempotent producer
 * (./testing/fake-timeline-server.ts — a port of the pinned server's
 * `validate_producer` and request rules), injecting the client-visible crash
 * windows:
 *
 * - `fail-before-apply` — network failure before the server applied.
 * - `fail-after-apply`  — server applied, ack lost (crash between append and
 *   trim: the flush retry MUST dedup, never duplicate).
 * - `crash-after-run`   — the whole `ctx.run` result is lost after the
 *   transport effects happened (at-least-once closure, SPIKE §e-2).
 *
 * Gate-3 invariants asserted after every recovered flush:
 * 1. the stream equals the exact staged event sequence (exactly once, in
 *    order — no duplicates, no losses, no reordering);
 * 2. seq is 0-based gapless (0001:A1) on the stream AND in allocation;
 * 3. the outbox K/V is empty and `outboxConfirmedSeq` == stream tail seq;
 * 4. catalog `head_seq` (trim-time tracker) == stream tail seq.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as restate from "@restatedev/restate-sdk";
import {
  checkSeqContiguity,
  checkTimelineInvariants,
  type TimelineEvent,
  type TimelineEventInit,
} from "@teaspill/schema";
import {
  AGENT_KV,
  type AgentRuntimeCtx,
  type AgentSharedRuntimeCtx,
} from "./agent-runtime.js";
import {
  DurableStreamsProjectionOutbox,
  OutboxBudgetError,
  OutboxDriftError,
  OUTBOX_KV,
  handleReconcileFlush,
  handleReconcileProbe,
  handleReconcileRecovery,
  timelineProducerId,
  timelineStreamPath,
} from "./projection-outbox.js";
import type { ProjectionOutbox as OutboxSeam } from "./agent-seams.js";
import { createNoopOutboxCatalog } from "./projection-catalog.js";
import {
  FakeTimelineServer,
  SimulatedNetworkError,
  validateProducer,
  type PlannedFault,
} from "./testing/fake-timeline-server.js";
import { InMemoryArchiveCatalog, commitEventsChunked } from "./agent-seams.js";
import { createStubHarness, createSendNotifier } from "./agent-seams.js";
import { applyArchive } from "./control.js";
import {
  reconcileEntity,
  type EntityReconcileClient,
  type ReconcilerAlert,
  type ReconcilerDeps,
  type ReconcilerRuntimeCtx,
  type ReconcilerSpec,
} from "./reconciler.js";
import { handleMessage, handleSpawn, type AgentObjectConfig } from "./agent.js";

// ---------------------------------------------------------------------------
// Fakes: the exclusive-handler runtime context with crash injection
// ---------------------------------------------------------------------------

class SimulatedCrashError extends Error {
  constructor(message = "simulated crash: ctx.run result lost before journaling") {
    super(message);
    this.name = "SimulatedCrashError";
  }
}

/**
 * Minimal `AgentRuntimeCtx` over a shared K/V map (state survives across
 * "invocation attempts" like real Restate K/V). `crashAfterRun` is one-shot:
 * the next `ctx.run` executes its closure (transport effects happen) and
 * then throws — modeling an attempt that dies after the side effects but
 * before the run result journals, so the retry re-executes the closure.
 */
class FakeCtx implements AgentRuntimeCtx {
  readonly key: string;
  readonly invocationId: string;
  readonly runAbortSignal = new AbortController().signal;
  crashAfterRun = false;
  /**
   * 0002:T2.1 — crash after the Nth SUCCESSFUL `ctx.run` action of this
   * attempt (1-based; a run whose action throws does not count). Lets the
   * reset tests place the crash at every journal boundary of a multi-step
   * handler (the recovery has up to ~5 runs). `null` ⇒ disabled.
   */
  crashOnRunNumber: number | null = null;
  #completedRuns = 0;

  constructor(
    private readonly kv: Map<string, unknown>,
    invocationId = "inv-1",
    key = "i-1",
  ) {
    this.invocationId = invocationId;
    this.key = key;
  }

  async get<T>(name: string): Promise<T | null> {
    return this.kv.has(name) ? (this.kv.get(name) as T) : null;
  }
  // NOTE (deliberately PESSIMISTIC model): set/clear commit to the shared map
  // IMMEDIATELY and survive a SimulatedCrashError — unlike real Restate, which
  // buffers K/V writes and rolls back the uncommitted suffix of a failed
  // attempt (the retry then REPLAYS the journal). Code that stays consistent
  // under this harsher every-write-commits model is a fortiori consistent
  // under Restate's; do not mistake it for a faithful replay model.
  set<T>(name: string, value: T): void {
    this.kv.set(name, value);
  }
  clear(name: string): void {
    this.kv.delete(name);
  }
  async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
    const result = await action();
    this.#completedRuns += 1;
    if (this.crashAfterRun || this.#completedRuns === this.crashOnRunNumber) {
      this.crashAfterRun = false;
      throw new SimulatedCrashError();
    }
    return result;
  }
  genericSend(): void {}
  raceInterrupt<T>(work: Promise<T>): Promise<T> {
    return work;
  }
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

const ENTITY = "/t/default/a/tester/i-1";
const PATH = timelineStreamPath(ENTITY);
const TS = "2026-07-17T00:00:00.000Z";

const spawnedInit: TimelineEventInit = {
  type: "entity_spawned",
  ts: TS,
  payload: { entityType: "tester", parentId: null },
};

function messageInit(n: number): TimelineEventInit {
  return {
    type: "message",
    ts: TS,
    payload: { id: `m-${n}`, role: "assistant", content: [{ type: "text", text: `event ${n}` }] },
  };
}

function makeOutbox(server: FakeTimelineServer) {
  const catalog = createNoopOutboxCatalog();
  const outbox = new DurableStreamsProjectionOutbox({ transport: server, catalog });
  return { outbox, catalog };
}

// ---------------------------------------------------------------------------
// PROPERTY TESTS (0001:Gate 3)
// ---------------------------------------------------------------------------

type AttemptFault =
  | { kind: "crash-after-run" }
  | { kind: "fail-before-apply" | "fail-after-apply"; afterAppends: number };

const attemptFaultArb: fc.Arbitrary<AttemptFault> = fc.oneof(
  fc.constant<AttemptFault>({ kind: "crash-after-run" }),
  fc.record({
    kind: fc.constantFrom<"fail-before-apply" | "fail-after-apply">(
      "fail-before-apply",
      "fail-after-apply",
    ),
    afterAppends: fc.integer({ min: 0, max: 3 }),
  }),
);

const stepArb = fc.record({
  batchSize: fc.integer({ min: 1, max: 4 }),
  faults: fc.array(attemptFaultArb, { maxLength: 3 }),
});

/**
 * Run one flush until it succeeds, injecting `faults` one per attempt (the
 * final attempt is clean). Only simulated failures may surface; anything
 * else (OutboxDriftError above all) fails the property.
 */
async function flushWithFaults(
  outbox: DurableStreamsProjectionOutbox,
  server: FakeTimelineServer,
  kv: Map<string, unknown>,
  faults: readonly AttemptFault[],
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const ctx = new FakeCtx(kv, `inv-${Math.random().toString(36).slice(2)}`);
    const fault = faults[attempt];
    server.clearFaults();
    if (fault?.kind === "crash-after-run") {
      ctx.crashAfterRun = true;
    } else if (fault) {
      server.planFaults([...Array<PlannedFault>(fault.afterAppends).fill("ok"), fault.kind]);
    }
    try {
      await outbox.flush(ctx, ENTITY);
      server.clearFaults();
      return;
    } catch (err) {
      if (err instanceof SimulatedNetworkError || err instanceof SimulatedCrashError) {
        expect(attempt).toBeLessThan(faults.length); // only injected faults may fail an attempt
        continue; // next attempt = Restate retry of the invocation
      }
      throw err;
    }
  }
}

function assertInvariants(
  server: FakeTimelineServer,
  kv: Map<string, unknown>,
  catalog: ReturnType<typeof createNoopOutboxCatalog>,
  expected: readonly TimelineEvent[],
): void {
  const timeline = server.timeline(PATH);
  // 1. exactly-once, in order
  expect(timeline).toStrictEqual(expected);
  // 2. 0-based gapless (0001:A1)
  expect(checkSeqContiguity(timeline, { expectedFirstSeq: 0 }).ok).toBe(true);
  expect(checkTimelineInvariants(timeline)).toStrictEqual([]);
  // 3. trimmed outbox + confirmed tracker
  expect(kv.get(AGENT_KV.outbox)).toStrictEqual([]);
  const tailSeq = expected.length - 1;
  expect(kv.get(OUTBOX_KV.confirmedSeq)).toBe(tailSeq);
  // 4. catalog head_seq tracks the trim-time confirmed seq
  const lastUpsert = catalog.upserts[catalog.upserts.length - 1];
  expect(lastUpsert?.headSeq).toBe(tailSeq);
  expect(lastUpsert?.entityId).toBe(ENTITY);
}

describe("DurableStreamsProjectionOutbox — property tests (0001:Gate 3)", () => {
  it("exactly-once, in-order, gapless projection under arbitrary crash/fault schedules", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (steps) => {
        const kv = new Map<string, unknown>();
        const server = new FakeTimelineServer();
        const { outbox, catalog } = makeOutbox(server);
        const expected: TimelineEvent[] = [];
        let n = 0;

        for (const step of steps) {
          const inits: TimelineEventInit[] = [];
          for (let i = 0; i < step.batchSize; i++) {
            inits.push(n === 0 && expected.length === 0 ? spawnedInit : messageInit(n));
            n += 1;
          }
          const stageCtx = new FakeCtx(kv);
          const finalized = await outbox.stage(stageCtx, ENTITY, inits);
          expected.push(...finalized);

          await flushWithFaults(outbox, server, kv, step.faults);
          assertInvariants(server, kv, catalog, expected);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("stage allocates 0-based gapless seqs across arbitrary batch splits, with NO I/O", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 10 }),
        async (batchSizes) => {
          const kv = new Map<string, unknown>();
          const server = new FakeTimelineServer();
          const { outbox } = makeOutbox(server);
          const all: TimelineEvent[] = [];
          let n = 0;
          for (const size of batchSizes) {
            const inits: TimelineEventInit[] = [];
            for (let i = 0; i < size; i++) {
              inits.push(n === 0 ? spawnedInit : messageInit(n));
              n += 1;
            }
            all.push(...(await outbox.stage(new FakeCtx(kv), ENTITY, inits)));
          }
          // gapless 0-based allocation, counter advanced, everything pending
          expect(checkSeqContiguity(all, { expectedFirstSeq: 0 }).ok).toBe(true);
          expect(kv.get(AGENT_KV.seq)).toBe(all.length);
          expect((kv.get(AGENT_KV.outbox) as TimelineEvent[]).length).toBe(all.length);
          // stage is pure K/V: the transport never saw a request (0001:D3: stage no-I/O)
          expect(server.appendRequests).toBe(0);
          expect(server.createRequests).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a flush retried from ANY partial-append point never duplicates or reorders", async () => {
    // Deterministic sweep (not random): fail after k applied appends for
    // every k, then recover — the stream must hold each event exactly once.
    for (let k = 0; k <= 5; k++) {
      const kv = new Map<string, unknown>();
      const server = new FakeTimelineServer();
      const { outbox, catalog } = makeOutbox(server);
      const inits = [spawnedInit, ...Array.from({ length: 4 }, (_, i) => messageInit(i + 1))];
      const expected = await outbox.stage(new FakeCtx(kv), ENTITY, inits);

      server.planFaults([...Array<PlannedFault>(k).fill("ok"), "fail-after-apply"]);
      await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(SimulatedNetworkError);
      // outbox intact (confirm-then-trim: nothing trimmed on failure)
      expect((kv.get(AGENT_KV.outbox) as TimelineEvent[]).length).toBe(5);

      server.clearFaults();
      const result = await outbox.flush(new FakeCtx(kv), ENTITY);
      expect(result.headSeq).toBe(4);
      assertInvariants(server, kv, catalog, expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit coverage: protocol edges
// ---------------------------------------------------------------------------

describe("DurableStreamsProjectionOutbox — flush protocol", () => {
  it("PUT-creates the stream on first use (C3), then never again", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);

    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit]);
    await outbox.flush(new FakeCtx(kv), ENTITY);
    expect(server.createRequests).toBe(1);

    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(1)]);
    await outbox.flush(new FakeCtx(kv), ENTITY);
    expect(server.createRequests).toBe(1); // no re-create once it exists
    expect(server.timeline(PATH).length).toBe(2);
  });

  it("flush of an empty outbox is a no-op returning the confirmed head", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);

    expect(await outbox.flush(new FakeCtx(kv), ENTITY)).toStrictEqual({
      appended: 0,
      headSeq: null,
    });

    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit, messageInit(1)]);
    await outbox.flush(new FakeCtx(kv), ENTITY);
    expect(await outbox.flush(new FakeCtx(kv), ENTITY)).toStrictEqual({
      appended: 0,
      headSeq: 1,
    });
    expect(server.timeline(PATH).length).toBe(2);
  });

  it("crash between append and trim: the replayed flush dedups (duplicate no-ops) and trims", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox, catalog } = makeOutbox(server);
    const expected = await outbox.stage(new FakeCtx(kv), ENTITY, [
      spawnedInit,
      messageInit(1),
      messageInit(2),
    ]);

    // All three appends APPLY on the server, then the ctx.run result is lost.
    const crashingCtx = new FakeCtx(kv);
    crashingCtx.crashAfterRun = true;
    await expect(outbox.flush(crashingCtx, ENTITY)).rejects.toThrow(SimulatedCrashError);
    expect(server.timeline(PATH).length).toBe(3); // effects happened...
    expect((kv.get(AGENT_KV.outbox) as TimelineEvent[]).length).toBe(3); // ...but nothing trimmed

    // Retry (new invocation): replays IN ORDER from the first unconfirmed;
    // every append is a duplicate no-op; then trim + confirm.
    const result = await outbox.flush(new FakeCtx(kv), ENTITY);
    expect(result.appended).toBe(0); // nothing NEW appended by the retry
    expect(result.headSeq).toBe(2);
    assertInvariants(server, kv, catalog, expected);
  });

  it("gap INSIDE the pending outbox is refused before any I/O (drift, not corruption)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit, messageInit(1), messageInit(2)]);

    // Tamper: drop the middle event (simulates a corrupted K/V value).
    const pending = kv.get(AGENT_KV.outbox) as TimelineEvent[];
    kv.set(AGENT_KV.outbox, [pending[0], pending[2]]);

    await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);
    expect(server.appendRequests).toBe(0); // refused BEFORE any append
  });

  it("pending head that skips past the confirmed seq is refused (drift)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit]);
    await outbox.flush(new FakeCtx(kv), ENTITY);

    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(1), messageInit(2)]);
    // Tamper: drop the first pending event so pending starts at confirmed+2.
    const pending = kv.get(AGENT_KV.outbox) as TimelineEvent[];
    kv.set(AGENT_KV.outbox, pending.slice(1));

    await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);
  });

  it("stream-tail-behind-outbox (producer state lost with trimmed events) surfaces as drift", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit, messageInit(1)]);
    await outbox.flush(new FakeCtx(kv), ENTITY);

    // Catastrophe: the stream vanishes server-side (0001:D3's catastrophic case).
    server.deleteStream(PATH);

    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(2)]);
    // Flush re-creates the stream (404 → PUT) but the fresh producer expects
    // seq 0 while the outbox replays seq 2 → gap → drift, loudly.
    await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);
  });

  it("a fenced (stale) producer epoch surfaces as drift", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await server.createStream(PATH);
    // Someone (a future repair path) already wrote at epoch 1.
    await server.appendEvent(PATH, JSON.stringify({ probe: true }), {
      id: timelineProducerId(ENTITY),
      epoch: 1,
      seq: 0,
    });

    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit]);
    await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);
  });

  it("a NEW epoch that does not restart at seq 0 surfaces as drift (bad epoch start)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit]);
    await outbox.flush(new FakeCtx(kv), ENTITY);

    kv.set(OUTBOX_KV.producerEpoch, 1); // simulated (incorrect) epoch bump
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(1)]); // seq 1 ≠ 0
    await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);
  });

  it("appending to a closed stream surfaces as drift", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit]);
    await outbox.flush(new FakeCtx(kv), ENTITY);

    server.closeStream(PATH);
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(1)]);
    await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);
  });

  it("resurrection continuation (K/V cleared, seq continues from catalog head_seq) flushes cleanly", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit, messageInit(1)]);
    await outbox.flush(new FakeCtx(kv), ENTITY);

    // 0001:T8.1 archive: clear ALL K/V. Resurrection restores only the seq counter
    // (head_seq + 1 from the catalog).
    kv.clear();
    kv.set(AGENT_KV.seq, 2);

    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(2)]);
    const result = await outbox.flush(new FakeCtx(kv), ENTITY);
    expect(result).toStrictEqual({ appended: 1, headSeq: 2 });
    expect(checkSeqContiguity(server.timeline(PATH), { expectedFirstSeq: 0 }).ok).toBe(true);
  });

  it("keeps independent producer/seq state per entity through one shared outbox instance", async () => {
    const otherEntity = "/t/default/a/tester/i-2";
    const kv1 = new Map<string, unknown>();
    const kv2 = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);

    await outbox.stage(new FakeCtx(kv1), ENTITY, [spawnedInit, messageInit(1)]);
    await outbox.stage(new FakeCtx(kv2, "inv-2", "i-2"), otherEntity, [spawnedInit]);
    await outbox.flush(new FakeCtx(kv1), ENTITY);
    await outbox.flush(new FakeCtx(kv2, "inv-2", "i-2"), otherEntity);

    expect(server.timeline(PATH).map((e) => e.seq)).toStrictEqual([0, 1]);
    expect(server.timeline(timelineStreamPath(otherEntity)).map((e) => e.seq)).toStrictEqual([0]);
    expect(server.timeline(PATH).every((e) => e.entityId === ENTITY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit coverage: the C4 producer model itself (out-of-order rejection)
// ---------------------------------------------------------------------------

describe("idempotent producer model (C4, mirrored from handlers.rs)", () => {
  it("rejects out-of-order seqs after a gap; in-order replay from the first unconfirmed recovers", async () => {
    const server = new FakeTimelineServer();
    await server.createStream(PATH);
    const producer = (seq: number) => ({ id: timelineProducerId(ENTITY), epoch: 0, seq });
    const ev = (seq: number) => JSON.stringify({ seq });

    expect((await server.appendEvent(PATH, ev(0), producer(0))).kind).toBe("accepted");
    // Reordered retry: seq 2 arrives while the server expects 1 → REJECTED.
    expect(await server.appendEvent(PATH, ev(2), producer(2))).toStrictEqual({
      kind: "gap",
      expectedSeq: 1,
      receivedSeq: 2,
    });
    // In-order replay from the first unconfirmed recovers fully.
    expect((await server.appendEvent(PATH, ev(1), producer(1))).kind).toBe("accepted");
    expect((await server.appendEvent(PATH, ev(2), producer(2))).kind).toBe("accepted");
    // And a duplicate of any confirmed seq is a no-op reporting the tail
    // (plus the current stream offset — a best-effort seek hint, 0001:T8.1).
    expect(await server.appendEvent(PATH, ev(1), producer(1))).toMatchObject({
      kind: "duplicate",
      lastSeq: 2,
    });
    expect(server.streams.get(PATH)!.records.length).toBe(3);
  });

  it("validateProducer mirrors validate_producer exactly", () => {
    // unknown producer
    expect(validateProducer(undefined, { epoch: 0, seq: 0 })).toStrictEqual({ kind: "accept" });
    expect(validateProducer(undefined, { epoch: 0, seq: 3 })).toStrictEqual({
      kind: "gap",
      expectedSeq: 0,
    });
    const state = { epoch: 2, lastSeq: 5 };
    // stale epoch
    expect(validateProducer(state, { epoch: 1, seq: 6 })).toStrictEqual({
      kind: "stale_epoch",
      currentEpoch: 2,
    });
    // new epoch must restart at 0
    expect(validateProducer(state, { epoch: 3, seq: 0 })).toStrictEqual({ kind: "accept" });
    expect(validateProducer(state, { epoch: 3, seq: 6 })).toStrictEqual({
      kind: "bad_epoch_start",
    });
    // same epoch: dup / next / gap
    expect(validateProducer(state, { epoch: 2, seq: 5 })).toStrictEqual({
      kind: "duplicate",
      lastSeq: 5,
    });
    expect(validateProducer(state, { epoch: 2, seq: 6 })).toStrictEqual({ kind: "accept" });
    expect(validateProducer(state, { epoch: 2, seq: 8 })).toStrictEqual({
      kind: "gap",
      expectedSeq: 6,
    });
  });
});

// ---------------------------------------------------------------------------
// Unit coverage: stage budgets (0001:A4/0001:R4)
// ---------------------------------------------------------------------------

describe("stage journal budgets (0001:A4/0001:R4)", () => {
  it("rejects a single oversized event BEFORE allocating its seq", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const outbox = new DurableStreamsProjectionOutbox({
      transport: server,
      maxEventBytes: 1024,
    });
    const big: TimelineEventInit = {
      type: "message",
      ts: TS,
      payload: {
        id: "m-big",
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(2048) }],
      },
    };
    await expect(outbox.stage(new FakeCtx(kv), ENTITY, [big])).rejects.toThrow(OutboxBudgetError);
    expect(await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit])).toHaveLength(1);
    // the rejected stage allocated nothing: seq 0 went to entity_spawned
    expect((kv.get(AGENT_KV.outbox) as TimelineEvent[])[0]!.seq).toBe(0);
    expect(kv.get(AGENT_KV.seq)).toBe(1);
  });

  it("rejects staging past the pending-outbox budget (caller must chunk, 0001:R4)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const outbox = new DurableStreamsProjectionOutbox({
      transport: server,
      maxPendingBytes: 600,
    });
    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit]);
    const filler = Array.from({ length: 8 }, (_, i) => messageInit(i + 1));
    await expect(outbox.stage(new FakeCtx(kv), ENTITY, filler)).rejects.toThrow(OutboxBudgetError);
  });

  it("budget errors are terminal (no Restate retry loop)", () => {
    expect(new OutboxBudgetError("x")).toBeInstanceOf(restate.TerminalError);
    expect(new OutboxDriftError("x")).toBeInstanceOf(restate.TerminalError);
  });
});

// ---------------------------------------------------------------------------
// Interface compatibility: the 0001:T2.1 agent pipeline over the REAL outbox
// ---------------------------------------------------------------------------

describe("agent pipeline over the real outbox (0001:T2.1 seam compatibility)", () => {
  function makeAgentConfig(server: FakeTimelineServer) {
    const catalog = createNoopOutboxCatalog();
    const config: AgentObjectConfig = {
      entityType: "tester",
      harness: createStubHarness(),
      outbox: new DurableStreamsProjectionOutbox({ transport: server, catalog }),
      notifier: createSendNotifier(),
    };
    return { config, catalog };
  }

  it("spawn + message wakes project a contiguous, exactly-once timeline via durable-streams", async () => {
    const server = new FakeTimelineServer();
    const { config, catalog } = makeAgentConfig(server);
    const kv = new Map<string, unknown>();

    const spawn = await handleSpawn(new FakeCtx(kv, "inv-spawn"), config, {
      args: { task: "hello" },
      parentRef: null,
    });
    expect(spawn.created).toBe(true);
    expect(spawn.outcome).toBe("success");

    const wake = await handleMessage(new FakeCtx(kv, "inv-msg"), config, {
      content: [{ type: "text", text: "again" }],
    });
    expect(wake.outcome).toBe("success");

    const timeline = server.timeline(timelineStreamPath(spawn.entityId));
    expect(timeline[0]!.type).toBe("entity_spawned");
    expect(checkSeqContiguity(timeline, { expectedFirstSeq: 0 }).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toStrictEqual([]);
    expect(kv.get(AGENT_KV.outbox)).toStrictEqual([]);
    expect(kv.get(OUTBOX_KV.confirmedSeq)).toBe(timeline[timeline.length - 1]!.seq);
    // catalog upserted at trim time, status carried
    const last = catalog.upserts[catalog.upserts.length - 1]!;
    expect(last.headSeq).toBe(timeline[timeline.length - 1]!.seq);
    expect(last.entityId).toBe(spawn.entityId);
  });

  it("commitEventsChunked over the real outbox flushes each bounded slice (0001:R4)", async () => {
    const server = new FakeTimelineServer();
    const { config } = makeAgentConfig(server);
    const kv = new Map<string, unknown>();
    const events: TimelineEventInit[] = [
      spawnedInit,
      ...Array.from({ length: 9 }, (_, i) => messageInit(i + 1)),
    ];
    const committed = await commitEventsChunked(
      new FakeCtx(kv),
      config.outbox,
      ENTITY,
      events,
      4, // chunk size: 4+4+2
    );
    expect(committed).toHaveLength(10);
    expect(server.timeline(PATH)).toStrictEqual(committed);
    expect(kv.get(AGENT_KV.outbox)).toStrictEqual([]);
    // At no point did the pending outbox hold more than one chunk.
    expect(kv.get(AGENT_KV.seq)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 0001:T8.1 — stream byte-offset capture for `state_snapshot` (0001:T5.2 fast-join seek)
// ---------------------------------------------------------------------------

describe("state_snapshot stream byte-offset capture (0001:T8.1)", () => {
  const snapshotInit: TimelineEventInit = {
    type: "state_snapshot",
    ts: TS,
    payload: { state: { note: "bounded context here" }, reason: "periodic" },
  };

  /** Cumulative byte length of the first `n` stream records — the fake's offset model. */
  function offsetAfter(server: FakeTimelineServer, n: number): string {
    const records = server.streams.get(PATH)!.records.slice(0, n);
    return String(records.reduce((sum, r) => sum + Buffer.byteLength(r, "utf8"), 0));
  }

  it("records the byte offset at which the snapshot record BEGINS + persists the stream end offset", async () => {
    const server = new FakeTimelineServer();
    const { outbox, catalog } = makeOutbox(server);
    const kv = new Map<string, unknown>();

    // spawn@0, message@1, state_snapshot@2 in ONE flush.
    await commitEventsChunked(
      new FakeCtx(kv, "inv-1"),
      outbox,
      ENTITY,
      [spawnedInit, messageInit(1), snapshotInit],
      16,
    );

    // The snapshot record (seq 2) begins where the stream ended after seq 0+1.
    const beginOffset = offsetAfter(server, 2);
    expect(catalog.snapshotUpserts).toEqual([
      { entityId: ENTITY, snapshotSeq: 2, snapshotStreamOffset: beginOffset },
    ]);
    // The end offset (after all 3 records) is persisted for the next flush.
    expect(kv.get(OUTBOX_KV.streamOffset)).toBe(offsetAfter(server, 3));
  });

  it("captures the begin offset from the PERSISTED end offset when the snapshot is in a later flush", async () => {
    const server = new FakeTimelineServer();
    const { outbox, catalog } = makeOutbox(server);
    const kv = new Map<string, unknown>();

    // Flush 1: spawn@0, message@1 — no snapshot, but streamOffset persisted.
    await commitEventsChunked(new FakeCtx(kv, "inv-1"), outbox, ENTITY, [spawnedInit, messageInit(1)], 16);
    expect(catalog.snapshotUpserts).toHaveLength(0);
    const endAfterFlush1 = kv.get(OUTBOX_KV.streamOffset);
    expect(endAfterFlush1).toBe(offsetAfter(server, 2));

    // Flush 2: a lone state_snapshot@2 — its begin offset is flush-1's end.
    await commitEventsChunked(new FakeCtx(kv, "inv-2"), outbox, ENTITY, [snapshotInit], 16);
    expect(catalog.snapshotUpserts).toEqual([
      { entityId: ENTITY, snapshotSeq: 2, snapshotStreamOffset: endAfterFlush1 },
    ]);
  });

  it("no snapshot in the flush ⇒ no snapshot upsert (only head upserts)", async () => {
    const server = new FakeTimelineServer();
    const { outbox, catalog } = makeOutbox(server);
    const kv = new Map<string, unknown>();
    await commitEventsChunked(new FakeCtx(kv, "inv-1"), outbox, ENTITY, [spawnedInit, messageInit(1)], 16);
    expect(catalog.snapshotUpserts).toHaveLength(0);
    expect(catalog.upserts.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 0002:T2.1 — affine offset append + epoch reset (0001:A9) — Gate 1
// ===========================================================================

const PRODUCER_ID = timelineProducerId(ENTITY);

/** Server-side producer state for the entity's timeline stream (fake internals). */
function producerState(server: FakeTimelineServer) {
  return server.streams.get(PATH)?.producers.get(PRODUCER_ID);
}

/** Minimal shared-context fake for the SHARED probe handler (read-only K/V). */
function sharedCtx(kv: Map<string, unknown>): AgentSharedRuntimeCtx {
  return {
    key: "i-1",
    get: async <T>(name: string): Promise<T | null> =>
      kv.has(name) ? (kv.get(name) as T) : null,
    cancelInvocation: () => {},
    genericSend: () => {},
  };
}

const RECOVER = { reason: "test drift", resetEpoch: true };

describe("affine offset + epoch reset — unit (0002:T2.1, 0001:A9)", () => {
  it("offset 0 / epoch 0 is the identity: Producer-Seq == canonical seq (0001:A1)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [spawnedInit, messageInit(1), messageInit(2)], 16);
    expect(producerState(server)).toStrictEqual({ epoch: 0, lastSeq: 2 });
    expect(kv.get(OUTBOX_KV.producerSeqOffset)).toBeUndefined(); // never written in normal op
  });

  it("lost stream: reset ⇒ epoch E+1, offset N; recovery snapshot appends at Producer-Seq 0; canonical seq stays gapless", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox, catalog } = makeOutbox(server);
    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [spawnedInit, messageInit(1), messageInit(2)], 16);

    // Catastrophe: the stream vanishes; two more events get stuck (seqs 3, 4).
    server.deleteStream(PATH);
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(3), messageInit(4)]);
    await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);

    const result = await handleReconcileRecovery(new FakeCtx(kv), { outbox }, ENTITY, RECOVER);
    // Snapshot allocated the NEXT canonical seq (5) — the counter never reset;
    // the stuck seqs 3–4 are inside the hole.
    expect(result).toStrictEqual({
      performed: true,
      epoch: 1,
      producerSeqOffset: 5,
      snapshotSeq: 5,
      flushed: true,
    });
    const timeline = server.timeline(PATH);
    expect(timeline.map((e) => e.seq)).toStrictEqual([5]);
    expect(timeline[0]!.type).toBe("state_snapshot");
    expect(timeline[0]!.payload).toMatchObject({ reason: "recovery", historyHole: true });
    // New epoch started at Producer-Seq 0 exactly as handlers.rs demands.
    expect(producerState(server)).toStrictEqual({ epoch: 1, lastSeq: 0 });
    expect(kv.get(OUTBOX_KV.producerEpoch)).toBe(1);
    expect(kv.get(OUTBOX_KV.producerSeqOffset)).toBe(5);
    expect(kv.get(OUTBOX_KV.confirmedSeq)).toBe(5);
    expect(kv.get(AGENT_KV.outbox)).toStrictEqual([]);
    // The stuck events' content survived into the folded context / snapshot state.
    const state = timeline[0]!.payload as unknown as { state: { context: TimelineEvent[] } };
    expect(state.state.context.map((e) => e.seq)).toContain(3);
    expect(state.state.context.map((e) => e.seq)).toContain(4);
    // The catalog got the snapshot SEQ (fast-join floor) with NO byte offset
    // (offsets from the lost stream are meaningless and were cleared).
    expect(catalog.snapshotUpserts).toStrictEqual([{ entityId: ENTITY, snapshotSeq: 5 }]);
    expect(kv.has(OUTBOX_KV.streamOffset)).toBe(true); // re-captured from the NEW stream's append

    // Later events append at seq − N under the new epoch; canonical stays contiguous from the hole.
    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [messageInit(6), messageInit(7)], 16);
    expect(server.timeline(PATH).map((e) => e.seq)).toStrictEqual([5, 6, 7]);
    expect(producerState(server)).toStrictEqual({ epoch: 1, lastSeq: 2 }); // 7 − 5
    expect(checkSeqContiguity(server.timeline(PATH), { expectedFirstSeq: 5 }).ok).toBe(true);
  });

  it("fenced epoch: the reset bumps ABOVE the server's epoch (structured drift detail)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await server.createStream(PATH);
    // A foreign writer (operational anomaly) holds epoch 5.
    await server.appendEvent(PATH, JSON.stringify({ probe: true }), {
      id: PRODUCER_ID,
      epoch: 5,
      seq: 0,
    });
    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit]);
    await expect(outbox.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);

    const result = await handleReconcileRecovery(new FakeCtx(kv), { outbox }, ENTITY, RECOVER);
    expect(result).toMatchObject({ performed: true, epoch: 6, flushed: true });
    expect(producerState(server)).toStrictEqual({ epoch: 6, lastSeq: 0 });
  });

  it("gated (resetEpoch: false) is a pure no-op: nothing written, pending intact (0001:A9 caution)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [spawnedInit], 16);
    server.deleteStream(PATH);
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(1)]);
    const before = new Map(kv);

    const result = await handleReconcileRecovery(new FakeCtx(kv), { outbox }, ENTITY, {
      reason: "gated",
      resetEpoch: false,
    });
    expect(result).toStrictEqual({ performed: false, reason: "gated" });
    expect(new Map(kv)).toStrictEqual(before); // byte-for-byte untouched
  });

  it("healthy outbox (drift healed before the request landed) ⇒ no reset", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [spawnedInit], 16);
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(1)]); // flushable, not stuck
    const result = await handleReconcileRecovery(new FakeCtx(kv), { outbox }, ENTITY, RECOVER);
    expect(result).toStrictEqual({ performed: false, reason: "healthy" });
    expect(kv.get(OUTBOX_KV.producerEpoch)).toBeUndefined();
    expect(server.timeline(PATH).map((e) => e.seq)).toStrictEqual([0, 1]); // the verify flush drained it
  });

  it("no live state ⇒ skipped", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    const result = await handleReconcileRecovery(new FakeCtx(kv), { outbox }, ENTITY, RECOVER);
    expect(result).toStrictEqual({ performed: false, reason: "no-live-state" });
  });

  it("closed stream: alert-and-HOLD — no reset, no per-tick churn, entity untouched and stable", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [spawnedInit], 16);
    server.closeStream(PATH);
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(1)]);
    const before = new Map(kv);

    // No epoch can EVER append to a closed stream, so a reset could never
    // make progress — it would only stage a fresh snapshot + bump the epoch
    // on every reconciler tick (unbounded canonical-seq/epoch inflation,
    // none of it reaching the stream). The handler holds instead.
    const result = await handleReconcileRecovery(new FakeCtx(kv), { outbox }, ENTITY, RECOVER);
    expect(result).toMatchObject({ performed: false, reason: "stream-closed" });
    expect(new Map(kv)).toStrictEqual(before); // byte-for-byte untouched

    // Stability under the reconciler's cadence: repeated recovery requests
    // (one per tick, forever) never inflate seq/epoch/pending.
    for (let tick = 0; tick < 3; tick++) {
      const again = await handleReconcileRecovery(new FakeCtx(kv), { outbox }, ENTITY, RECOVER);
      expect(again).toMatchObject({ performed: false, reason: "stream-closed" });
    }
    expect(new Map(kv)).toStrictEqual(before);
    expect(kv.get(AGENT_KV.seq)).toBe(2); // no snapshot ever staged
  });

  it("REGRESSION: a snapshot rejected by the OUTBOX budgets never strands an unmarked hole (pending restored)", async () => {
    // Misconfigured limits: `archiveSnapshotMaxBytes` (bounds the snapshot
    // STATE) and the outbox's `maxEventBytes` (bounds the staged EVENT) are
    // independent knobs. A snapshot state that passes the former can produce
    // an event the latter rejects — `stage` then throws OutboxBudgetError
    // AFTER the recovery has already dropped the doomed pending events. The
    // handler must restore the pre-drop K/V and report `failed`, never commit
    // the drop without the historyHole marker.
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const catalog = createNoopOutboxCatalog();
    const outbox = new DurableStreamsProjectionOutbox({
      transport: server,
      catalog,
      maxEventBytes: 1900, // below the default 256 KiB archiveSnapshotMaxBytes
    });
    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [spawnedInit], 16);
    server.deleteStream(PATH); // catastrophic loss ⇒ genuine drift
    // A stuck event small enough to stage (~1.6 KiB < 2048) whose folded
    // context makes the snapshot EVENT exceed maxEventBytes.
    const bigMessage: TimelineEventInit = {
      type: "message",
      ts: TS,
      payload: {
        id: "m-big",
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(1500) }],
      },
    };
    await outbox.stage(new FakeCtx(kv), ENTITY, [bigMessage]);
    const before = new Map(kv);

    const result = await handleReconcileRecovery(new FakeCtx(kv), { outbox }, ENTITY, RECOVER);
    expect(result).toMatchObject({ performed: false, reason: "failed" });
    expect((result as { message?: string }).message).toMatch(/journal budget/);
    // Pre-drop state fully restored: pending intact for a later retry, no
    // seq allocated, no epoch/offset written, nothing dropped unmarked.
    expect(new Map(kv)).toStrictEqual(before);
    expect((kv.get(AGENT_KV.outbox) as TimelineEvent[]).map((e) => e.seq)).toStrictEqual([1]);
    expect(kv.get(AGENT_KV.seq)).toBe(2);
    expect(kv.get(OUTBOX_KV.producerEpoch)).toBeUndefined();
    expect(kv.get(OUTBOX_KV.producerSeqOffset)).toBeUndefined();
    // And with sane limits the SAME entity recovers fully (marker staged).
    const saneOutbox = new DurableStreamsProjectionOutbox({ transport: server, catalog });
    const recovered = await handleReconcileRecovery(new FakeCtx(kv), { outbox: saneOutbox }, ENTITY, RECOVER);
    expect(recovered).toMatchObject({ performed: true, epoch: 1, snapshotSeq: 2, flushed: true });
    expect(server.timeline(PATH).map((e) => e.seq)).toStrictEqual([2]);
  });

  it("epoch + offset are INVISIBLE to readers (0001:A6#2): stream records are exactly the canonical events", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    const staged = new Map<number, TimelineEvent>();
    const recording = recordStages(outbox, staged);
    await commitEventsChunked(new FakeCtx(kv), recording, ENTITY, [spawnedInit, messageInit(1)], 16);
    server.deleteStream(PATH);
    await recording.stage(new FakeCtx(kv), ENTITY, [messageInit(2)]);
    await expect(recording.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);
    await handleReconcileRecovery(new FakeCtx(kv), { outbox: recording }, ENTITY, RECOVER);
    await commitEventsChunked(new FakeCtx(kv), recording, ENTITY, [messageInit(4)], 16);

    // Byte-level: every stream record parses to EXACTLY the staged canonical
    // event — no producer epoch/offset (or any other transport metadata) leaks
    // into what a reader sees; reading is canonical-seq based only.
    const raw = server.streams.get(PATH)!.records;
    for (const json of raw) {
      const parsed = JSON.parse(json) as TimelineEvent;
      expect(parsed).toStrictEqual(staged.get(parsed.seq));
      expect(Object.keys(parsed).sort()).toStrictEqual(
        Object.keys(staged.get(parsed.seq)!).sort(),
      );
    }
  });

  it("a reset survives archive → resurrection (epoch/offset carried through the snapshot)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    const archiveCatalog = new InMemoryArchiveCatalog();
    const config: AgentObjectConfig = {
      entityType: "tester",
      harness: createStubHarness(),
      outbox,
      notifier: createSendNotifier(),
      archiveCatalog,
    };

    const spawn = await handleSpawn(new FakeCtx(kv, "inv-spawn"), config, { args: { t: 1 } });
    expect(spawn.outcome).toBe("success");

    // Catastrophe mid-life: stream lost; the next wake fails on its flush.
    server.deleteStream(PATH);
    await expect(
      handleMessage(new FakeCtx(kv, "inv-lost"), config, { content: [{ type: "text", text: "x" }] }),
    ).rejects.toThrow(OutboxDriftError);
    const recovery = await handleReconcileRecovery(new FakeCtx(kv, "inv-rec"), { outbox }, ENTITY, RECOVER);
    expect(recovery).toMatchObject({ performed: true, epoch: 1, flushed: true });

    // Post-reset wakes work; then archive persists epoch/offset in the snapshot.
    const wake = await handleMessage(new FakeCtx(kv, "inv-msg"), config, {
      content: [{ type: "text", text: "after reset" }],
    });
    expect(wake.outcome).toBe("success");
    await applyArchive(new FakeCtx(kv, "inv-archive"), config, { trigger: "requested" });
    const row = archiveCatalog.rows.get(ENTITY)!;
    expect(row.snapshot).toMatchObject({
      producerEpoch: 1,
      producerSeqOffset: (recovery as { producerSeqOffset: number }).producerSeqOffset,
    });
    expect(kv.size).toBe(0); // K/V fully cleared

    // Resurrection restores the post-reset epoch/offset — the next wake's
    // flush appends at the SAME epoch instead of being fenced at epoch 0.
    const resurrected = await handleMessage(new FakeCtx(kv, "inv-resurrect"), config, {
      content: [{ type: "text", text: "wake the dead" }],
    });
    expect(resurrected.outcome).toBe("success");
    expect(kv.get(OUTBOX_KV.producerEpoch)).toBe(1);
    expect(producerState(server)!.epoch).toBe(1);
    const timeline = server.timeline(PATH);
    expect(checkSeqContiguity(timeline, { expectedFirstSeq: timeline[0]!.seq }).ok).toBe(true);
  });

  it("recovery crash-retried from EVERY journal boundary converges (deterministic sweep)", async () => {
    for (let crashAt = 1; crashAt <= 5; crashAt++) {
      const kv = new Map<string, unknown>();
      const server = new FakeTimelineServer();
      const { outbox } = makeOutbox(server);
      const staged = new Map<number, TimelineEvent>();
      const recording = recordStages(outbox, staged);
      await commitEventsChunked(new FakeCtx(kv), recording, ENTITY, [spawnedInit, messageInit(1)], 16);
      server.deleteStream(PATH);
      await recording.stage(new FakeCtx(kv), ENTITY, [messageInit(2)]);
      await expect(recording.flush(new FakeCtx(kv), ENTITY)).rejects.toThrow(OutboxDriftError);

      // Attempt 1 crashes after its `crashAt`-th completed ctx.run step; the
      // retry (a fresh invocation over the surviving K/V) must converge.
      const crashing = new FakeCtx(kv, `inv-crash-${crashAt}`);
      crashing.crashOnRunNumber = crashAt;
      let firstOutcome: "crashed" | "completed";
      try {
        await handleReconcileRecovery(crashing, { outbox: recording }, ENTITY, RECOVER);
        firstOutcome = "completed"; // crash point beyond this run's steps
      } catch (err) {
        expect(err).toBeInstanceOf(SimulatedCrashError);
        firstOutcome = "crashed";
      }
      const retry = await handleReconcileRecovery(
        new FakeCtx(kv, `inv-retry-${crashAt}`),
        { outbox: recording },
        ENTITY,
        RECOVER,
      );
      if (firstOutcome === "crashed") {
        expect(
          (retry.performed && retry.flushed) ||
            (!retry.performed && retry.reason === "healthy"),
        ).toBe(true);
      } else {
        expect(retry).toMatchObject({ performed: false, reason: "healthy" });
      }
      assertResetInvariants(server, kv, staged);
    }
  });
});

describe("reconcile handler logic — probe + flush (0002:T2.1)", () => {
  it("probe: null before spawn; live confirmed/pending after; ZERO transport I/O", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    expect(await handleReconcileProbe(sharedCtx(kv))).toBeNull();

    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [spawnedInit, messageInit(1)], 16);
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(2), messageInit(3)]);
    const requestsBefore = server.appendRequests + server.createRequests;
    const probe = await handleReconcileProbe(sharedCtx(kv));
    expect(probe).toStrictEqual({
      status: "idle", // no wake handler ran in this test — status defaults
      confirmedSeq: 1,
      pendingCount: 2,
      pendingFirstSeq: 2,
      pendingLastSeq: 3,
    });
    // Cheap by construction: the SHARED context has no `run` and the probe
    // never touches the transport — safe against a busy exclusive wake.
    expect(server.appendRequests + server.createRequests).toBe(requestsBefore);
  });

  it("flush: drives the outbox; maps OutboxDriftError to the drift outcome (never rethrows it)", async () => {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox } = makeOutbox(server);
    expect(await handleReconcileFlush(new FakeCtx(kv), outbox, ENTITY)).toStrictEqual({
      kind: "flushed",
      headSeq: null,
      appended: 0,
    });

    await outbox.stage(new FakeCtx(kv), ENTITY, [spawnedInit, messageInit(1)]);
    expect(await handleReconcileFlush(new FakeCtx(kv), outbox, ENTITY)).toStrictEqual({
      kind: "flushed",
      headSeq: 1,
      appended: 2,
    });

    server.deleteStream(PATH);
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(2)]);
    const outcome = await handleReconcileFlush(new FakeCtx(kv), outbox, ENTITY);
    expect(outcome.kind).toBe("drift");
  });
});

describe("reconciler → agent object, end to end over the REAL handlers (0001:A9 split)", () => {
  /** Adapter: the reconciler-side seam calling the agent-side handler LOGIC directly. */
  function logicClient(kv: Map<string, unknown>, outbox: OutboxSeam): EntityReconcileClient {
    return {
      probe: async () => handleReconcileProbe(sharedCtx(kv)),
      driveFlush: async (_ctx, entityId) =>
        handleReconcileFlush(new FakeCtx(kv, "inv-drive-flush"), outbox, entityId),
      driveRecovery: async (_ctx, entityId, opts) => {
        await handleReconcileRecovery(new FakeCtx(kv, "inv-drive-rec"), { outbox }, entityId, opts);
      },
    };
  }

  function reconcilerCtx(): ReconcilerRuntimeCtx {
    return {
      key: "default",
      get: async () => null,
      set: () => {},
      clear: () => {},
      run: async (_name, action) => action(),
      genericSend: () => {},
      genericCall: async () => {
        throw new Error("unused");
      },
    };
  }

  async function brokenEntity() {
    const kv = new Map<string, unknown>();
    const server = new FakeTimelineServer();
    const { outbox, catalog } = makeOutbox(server);
    await commitEventsChunked(new FakeCtx(kv), outbox, ENTITY, [spawnedInit, messageInit(1)], 16);
    server.deleteStream(PATH); // catastrophic loss
    await outbox.stage(new FakeCtx(kv), ENTITY, [messageInit(2)]); // stuck
    const alerts: ReconcilerAlert[] = [];
    const deps: ReconcilerDeps = {
      sampler: { sample: async () => [] },
      client: logicClient(kv, outbox),
      catalog,
      alert: { fire: (a) => alerts.push(a) },
    };
    const sample = { url: ENTITY, type: "tester", status: "idle" as const, headSeq: 1 };
    return { kv, server, outbox, deps, sample, alerts };
  }

  it("unrecoverable drift with the gate OPEN: alert + executed reset + healed stream", async () => {
    const { kv, server, deps, sample, alerts } = await brokenEntity();
    const spec: ReconcilerSpec = { intervalMs: 60_000, batchSize: 50, allowEpochReset: true };
    const report = await reconcileEntity(reconcilerCtx(), deps, sample, spec);
    expect(report).toStrictEqual({ entityId: ENTITY, drift: "stuck_outbox", action: "recovery_snapshot" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("unrecoverable_drift");
    // The agent object EXECUTED the reset the reconciler requested:
    expect(kv.get(OUTBOX_KV.producerEpoch)).toBe(1);
    expect(kv.get(OUTBOX_KV.producerSeqOffset)).toBe(3);
    const timeline = server.timeline(PATH);
    expect(timeline.map((e) => e.seq)).toStrictEqual([3]);
    expect(timeline[0]!.payload).toMatchObject({ reason: "recovery", historyHole: true });
    // Next tick sees a healthy entity (probe: no pending, catalog repairable lag only).
    const report2 = await reconcileEntity(reconcilerCtx(), deps, { ...sample, headSeq: 1 }, spec);
    expect(report2.action).toBe("catalog_lag_repaired"); // head_seq floor catches up (0001:A6#5)
    const report3 = await reconcileEntity(reconcilerCtx(), deps, { ...sample, headSeq: 3 }, spec);
    expect(report3).toStrictEqual({ entityId: ENTITY, drift: "none", action: "ok" });
  });

  it("unrecoverable drift with the gate CLOSED: alert + gated, entity untouched", async () => {
    const { kv, deps, sample, alerts } = await brokenEntity();
    const spec: ReconcilerSpec = { intervalMs: 60_000, batchSize: 50, allowEpochReset: false };
    const before = new Map(kv);
    const report = await reconcileEntity(reconcilerCtx(), deps, sample, spec);
    expect(report).toStrictEqual({ entityId: ENTITY, drift: "stuck_outbox", action: "recovery_gated" });
    expect(alerts).toHaveLength(1);
    expect(new Map(kv)).toStrictEqual(before); // non-destructive: nothing written
  });
});

// ---------------------------------------------------------------------------
// Gate 1 property suite: arbitrary crash schedules ACROSS reset boundaries
// ---------------------------------------------------------------------------

/** Wrap an outbox so every staged (finalized) event is recorded by seq — including the recovery snapshots the reset stages internally. */
function recordStages(inner: OutboxSeam, record: Map<number, TimelineEvent>): OutboxSeam {
  return {
    async stage(ctx, entityId, events) {
      const out = await inner.stage(ctx, entityId, events);
      for (const ev of out) record.set(ev.seq, ev);
      return out;
    },
    flush(ctx, entityId) {
      return inner.flush(ctx, entityId);
    },
  };
}

/**
 * The Gate 1 invariants, checked after every settled step:
 *  1. same-seq stream records (the 0001:A6#2 dedup window) are byte-identical;
 *     the reader view = first record per seq.
 *  2. reader view is strictly seq-ascending (in-order after seq-dedup).
 *  3. every gap in the reader view is bridged by a `state_snapshot` with
 *     `historyHole: true` (holes are always marked); a timeline not starting
 *     at seq 0 starts with such a snapshot.
 *  4. exactly-once content: every visible record deep-equals the canonical
 *     event staged for that seq — byte-level, so epoch/offset are provably
 *     invisible to readers (0001:A6#2).
 *  5. canonical seq allocation is 0-based gapless (0001:A1) — holes cost
 *     stream visibility, never seq slots.
 *  6. K/V settled: outbox empty, `outboxConfirmedSeq` == the canonical head.
 *  7. affine consistency: server producer state == (K/V epoch, head − offset).
 */
function assertResetInvariants(
  server: FakeTimelineServer,
  kv: Map<string, unknown>,
  staged: Map<number, TimelineEvent>,
): void {
  const stream = server.streams.get(PATH);
  expect(stream).toBeDefined();
  const raw = stream!.records;

  // 1. reader dedup by embedded seq; duplicates must be byte-identical.
  const firstJsonBySeq = new Map<number, string>();
  const visible: TimelineEvent[] = [];
  for (const json of raw) {
    const ev = JSON.parse(json) as TimelineEvent;
    const prior = firstJsonBySeq.get(ev.seq);
    if (prior === undefined) {
      firstJsonBySeq.set(ev.seq, json);
      visible.push(ev);
    } else {
      expect(json).toBe(prior);
    }
  }

  // 2 + 3. in-order; holes only at (and marked by) historyHole snapshots.
  for (let i = 1; i < visible.length; i++) {
    const a = visible[i - 1]!;
    const b = visible[i]!;
    expect(b.seq).toBeGreaterThan(a.seq);
    if (b.seq !== a.seq + 1) {
      expect(b.type).toBe("state_snapshot");
      expect((b.payload as { historyHole?: boolean }).historyHole).toBe(true);
    }
  }
  const first = visible[0];
  if (first !== undefined && first.seq !== 0) {
    expect(first.type).toBe("state_snapshot");
    expect((first.payload as { historyHole?: boolean }).historyHole).toBe(true);
  }

  // 4. exactly-once content, byte-level (reader invisibility of epoch/offset).
  for (const ev of visible) {
    expect(ev).toStrictEqual(staged.get(ev.seq));
  }

  // 5. canonical allocation 0-based gapless (0001:A1).
  const allSeqs = [...staged.keys()].sort((x, y) => x - y);
  expect(allSeqs[0]).toBe(0);
  expect(allSeqs[allSeqs.length - 1]).toBe(allSeqs.length - 1);
  expect(kv.get(AGENT_KV.seq)).toBe(allSeqs.length);

  // 6. K/V settled.
  const head = allSeqs.length - 1;
  expect(kv.get(AGENT_KV.outbox)).toStrictEqual([]);
  expect(kv.get(OUTBOX_KV.confirmedSeq)).toBe(head);

  // 7. affine consistency.
  const epoch = (kv.get(OUTBOX_KV.producerEpoch) as number | undefined) ?? 0;
  const offset = (kv.get(OUTBOX_KV.producerSeqOffset) as number | undefined) ?? 0;
  expect(producerState(server)).toStrictEqual({ epoch, lastSeq: head - offset });
}

type RecoveryFault =
  | { kind: "crash-run"; runNumber: number }
  | { kind: "fail-before-apply" | "fail-after-apply"; afterAppends: number };

const recoveryFaultArb: fc.Arbitrary<RecoveryFault> = fc.oneof(
  fc.record({ kind: fc.constant<"crash-run">("crash-run"), runNumber: fc.integer({ min: 1, max: 5 }) }),
  fc.record({
    kind: fc.constantFrom<"fail-before-apply" | "fail-after-apply">(
      "fail-before-apply",
      "fail-after-apply",
    ),
    afterAppends: fc.integer({ min: 0, max: 2 }),
  }),
);

const resetStepArb = fc.record({
  batchSize: fc.integer({ min: 1, max: 3 }),
  catastrophe: fc.constantFrom<"none" | "delete-stream" | "rollback-producer">(
    "none",
    "none", // weight normal steps higher
    "delete-stream",
    "rollback-producer",
  ),
  flushFaults: fc.array(attemptFaultArb, { maxLength: 2 }),
  recoveryFaults: fc.array(recoveryFaultArb, { maxLength: 2 }),
});

/**
 * Like `flushWithFaults`, but a drift on the final (clean) attempt is a legal
 * outcome — it is the property's cue to run the recovery path. Returns "ok"
 * when the flush settled, "drift" when it terminally drifted.
 */
async function flushUntilSettledOrDrift(
  outbox: OutboxSeam,
  server: FakeTimelineServer,
  kv: Map<string, unknown>,
  faults: readonly AttemptFault[],
): Promise<"ok" | "drift"> {
  for (let attempt = 0; ; attempt++) {
    const ctx = new FakeCtx(kv, `inv-f${attempt}-${Math.random().toString(36).slice(2)}`);
    const fault = faults[attempt];
    server.clearFaults();
    if (fault?.kind === "crash-after-run") {
      ctx.crashAfterRun = true;
    } else if (fault) {
      server.planFaults([...Array<PlannedFault>(fault.afterAppends).fill("ok"), fault.kind]);
    }
    try {
      await outbox.flush(ctx, ENTITY);
      server.clearFaults();
      return "ok";
    } catch (err) {
      if (err instanceof SimulatedNetworkError || err instanceof SimulatedCrashError) {
        expect(attempt).toBeLessThan(faults.length);
        continue;
      }
      server.clearFaults();
      if (err instanceof OutboxDriftError) return "drift";
      throw err;
    }
  }
}

/**
 * Drive the recovery to convergence under injected faults, exactly as Restate
 * would: every simulated failure aborts the attempt; the retry re-runs the
 * handler over the surviving K/V. Settled = the reset flushed, or a re-run
 * found the previous attempt already converged (`healthy`).
 */
async function recoverWithFaults(
  outbox: OutboxSeam,
  server: FakeTimelineServer,
  kv: Map<string, unknown>,
  faults: readonly RecoveryFault[],
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const ctx = new FakeCtx(kv, `inv-r${attempt}-${Math.random().toString(36).slice(2)}`);
    const fault = faults[attempt];
    server.clearFaults();
    if (fault?.kind === "crash-run") {
      ctx.crashOnRunNumber = fault.runNumber;
    } else if (fault) {
      server.planFaults([...Array<PlannedFault>(fault.afterAppends).fill("ok"), fault.kind]);
    }
    try {
      const result = await handleReconcileRecovery(ctx, { outbox }, ENTITY, {
        reason: "property drift",
        resetEpoch: true,
      });
      server.clearFaults();
      const settled =
        (result.performed && result.flushed) ||
        (!result.performed && result.reason === "healthy");
      expect(settled).toBe(true); // no closed streams in these schedules
      return;
    } catch (err) {
      if (err instanceof SimulatedNetworkError || err instanceof SimulatedCrashError) {
        // Injected faults may crash an attempt; a clean attempt must settle.
        expect(attempt).toBeLessThanOrEqual(faults.length);
        continue;
      }
      throw err;
    }
  }
}

describe("epoch reset — property suite (0002:T2.1 Gate 1)", () => {
  it("exactly-once / in-order / canonical-gapless / marked-holes / reader seq-dedup across arbitrary catastrophe + crash schedules", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(resetStepArb, { minLength: 1, maxLength: 6 }), async (steps) => {
        const kv = new Map<string, unknown>();
        const server = new FakeTimelineServer();
        const { outbox } = makeOutbox(server);
        const staged = new Map<number, TimelineEvent>();
        const recording = recordStages(outbox, staged);
        let n = 0;

        for (const step of steps) {
          // 1. Stage a batch of new canonical events (seq allocation never resets).
          const inits: TimelineEventInit[] = [];
          for (let i = 0; i < step.batchSize; i++) {
            inits.push(n === 0 ? spawnedInit : messageInit(n));
            n += 1;
          }
          await recording.stage(new FakeCtx(kv), ENTITY, inits);

          // 2. Optional server-side catastrophe (0001:D3's cases).
          if (step.catastrophe === "delete-stream") {
            server.deleteStream(PATH);
          } else if (step.catastrophe === "rollback-producer") {
            const state = producerState(server);
            if (state !== undefined && state.lastSeq >= 1) {
              server.rollbackProducerState(PATH, PRODUCER_ID, state.lastSeq - 1);
            }
          }

          // 3. Flush under the fault schedule; a terminal drift routes to the
          //    reconciler-requested, agent-executed recovery (0001:A9 split),
          //    itself under its own fault schedule.
          const settled = await flushUntilSettledOrDrift(recording, server, kv, step.flushFaults);
          if (settled === "drift") {
            await recoverWithFaults(recording, server, kv, step.recoveryFaults);
            n = kv.get(AGENT_KV.seq) as number; // recovery snapshots consumed seq slots
          }

          assertResetInvariants(server, kv, staged);
        }
      }),
      { numRuns: 120 },
    );
  });
});
