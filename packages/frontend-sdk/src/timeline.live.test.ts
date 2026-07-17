/**
 * LIVE smoke test against the REAL pinned streams server
 * (`electricax/durable-streams-server-rust:0.1.4`) — skip-guarded like the
 * gateway's R5 live suite. Run with:
 *
 *   docker run -d --rm --name teaspill-t52-smoke -p 14437:4437 \
 *     -e DS_SERVER__PORT=4437 -e DS_STORAGE__MODE=memory \
 *     electricax/durable-streams-server-rust:0.1.4
 *   TEASPILL_LIVE_STREAMS_URL=http://127.0.0.1:14437 pnpm vitest run src/timeline.live.test.ts
 *
 * Exercises the exact production write path (PUT create per addressing C3,
 * POST per event with Producer-Id = entity url / Producer-Seq = seq — the
 * A1/A6 outbox identity), then reads back with createAgentTimeline: full
 * replay, A6 duplicate readmission, and A7 fast-join from a real byte offset.
 */

import { describe, expect, it } from "vitest";
import { createAgentTimeline } from "./timeline.js";
import {
  FIXTURE_ENTITY_ID,
  FIXTURE_SNAPSHOT_SEQ,
  FIXTURE_SNAPSHOT_STATE,
  delta,
  fullHistory,
} from "./fixtures.js";

const BASE = process.env["TEASPILL_LIVE_STREAMS_URL"];

describe.skipIf(BASE === undefined)("live streams server smoke (T5.2)", () => {
  const suffix = Date.now().toString(36);
  const TIMELINE = `${BASE}/t/default/agents/researcher/01smoke${suffix}/timeline`;
  const DELTAS = `${BASE}/t/default/agents/researcher/01smoke${suffix}/deltas`;

  async function must(res: Response, what: string, ...ok: number[]): Promise<Response> {
    if (!ok.includes(res.status)) {
      throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
    }
    return res;
  }

  it("writes the fixture history via the producer protocol and reads it back", async () => {
    const json = { "content-type": "application/json" };
    await must(await fetch(TIMELINE, { method: "PUT", headers: json }), "PUT", 200, 201, 204, 409);
    await must(await fetch(DELTAS, { method: "PUT", headers: json }), "PUT", 200, 201, 204, 409);

    // Append with Producer-Seq = canonical seq (A1 identity); capture the
    // byte offset just before the snapshot record for the fast-join read.
    let snapshotOffset: string | null = null;
    for (const ev of fullHistory()) {
      if (ev.seq === FIXTURE_SNAPSHOT_SEQ) {
        const head = await must(await fetch(TIMELINE, { method: "HEAD" }), "HEAD", 200);
        snapshotOffset = head.headers.get("stream-next-offset");
      }
      await must(
        await fetch(TIMELINE, {
          method: "POST",
          headers: {
            ...json,
            "producer-id": FIXTURE_ENTITY_ID,
            "producer-epoch": "0",
            "producer-seq": String(ev.seq),
          },
          body: JSON.stringify(ev),
        }),
        `POST seq ${ev.seq}`,
        200,
        204,
      );
    }
    // A6 #3: same-epoch seq <= last ⇒ idempotent no-op (204).
    const dup = await fetch(TIMELINE, {
      method: "POST",
      headers: {
        ...json,
        "producer-id": FIXTURE_ENTITY_ID,
        "producer-epoch": "0",
        "producer-seq": "18",
      },
      body: JSON.stringify(fullHistory()[18]),
    });
    expect(dup.status).toBe(204);
    // Sibling deltas lane (non-idempotent writer, deltas.ts).
    await must(
      await fetch(DELTAS, {
        method: "POST",
        headers: json,
        body: JSON.stringify(delta({ kind: "text", ref: "m-live2", idx: 0, text: "live!" })),
      }),
      "POST delta",
      200,
      204,
    );

    // Full replay.
    const full = createAgentTimeline(TIMELINE, { live: false, deltas: true });
    const fullState = await full.untilUpToDate();
    full.close();
    await full.closed;
    expect(fullState.timeline.appliedThroughSeq).toBe(24);
    expect(fullState.timeline.drift).toBeNull();
    expect(fullState.parseErrors).toBe(0);
    expect(fullState.timeline.messages).toHaveLength(6);
    expect(fullState.timeline.runs).toHaveLength(3);

    // Fast-join from the real byte offset (A7: snapshot@15 then 16..24).
    const joined = createAgentTimeline(TIMELINE, {
      live: false,
      fromSnapshot: {
        seq: FIXTURE_SNAPSHOT_SEQ,
        ...(snapshotOffset !== null ? { offset: snapshotOffset } : {}),
      },
    });
    const joinedState = await joined.untilUpToDate();
    joined.close();
    await joined.closed;
    const j = joinedState.timeline;
    expect(j.join).toEqual({ mode: "snapshot", seq: FIXTURE_SNAPSHOT_SEQ, complete: true });
    expect(j.entityState).toEqual(FIXTURE_SNAPSHOT_STATE);
    expect(j.appliedThroughSeq).toBe(24);
    expect(j.drift).toBeNull();
    expect(j.messages.map((m) => m.id)).toEqual(["m-u2", "m-c1"]);
    expect(j.messages.every((m) => m.seq > FIXTURE_SNAPSHOT_SEQ)).toBe(true);
  }, 30_000);
});
