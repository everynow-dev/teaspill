/**
 * Scenario 4 — projection continuity through a streams-server restart. OFFLINE
 * against the REAL projection outbox over the fake streams server: a flush is
 * interrupted by a restart that (a) loses the ack and (b) rolls the debounced
 * producer-dedup state back to an earlier checkpoint (A6 #2). On recovery the
 * outbox replays from the first-unconfirmed seq; the server re-admits an
 * already-acked append as a DUPLICATE RECORD, and the reader — deduping by
 * canonical seq (`checkSeqContiguity`, the frontend reducer) — still sees a
 * gapless timeline with ZERO seq gaps. Plus a live-gated end-to-end.
 */

import { describe, expect, it } from "vitest";
import { DurableStreamsProjectionOutbox, timelineStreamPath } from "@teaspill/coordination";
import {
  applyTimelineEvents,
  checkSeqContiguity,
  initialTimelineState,
} from "@teaspill/frontend-sdk";
import { PROJECTION_CONTINUITY } from "./scenarios.js";
import { expectInvariant } from "./types.js";
import { MemoryWorld } from "./support/memory-ctx.js";
import { FakeStreamsServer } from "./support/fake-streams.js";
import {
  assistantMessageInit,
  runFinishedInit,
  runStartedInit,
  spawnedInit,
  userMessageInit,
} from "./support/run-fixtures.js";
import { createLiveDriver, readStackConfig, SKIP_MESSAGE } from "./live.js";

const ENTITY = "/t/default/a/conformance-echo/e-2";

async function runContinuityRestart() {
  const world = new MemoryWorld("e-2");
  const server = new FakeStreamsServer();
  const outbox = new DurableStreamsProjectionOutbox({ transport: server });
  const path = timelineStreamPath(ENTITY);

  // Phase 1: spawn + run_started + user message — cleanly confirmed (seq 0..2).
  const w1 = world.ctx({ invocationId: "w1" });
  await outbox.stage(w1, ENTITY, [spawnedInit, runStartedInit, userMessageInit("ping")]);
  await outbox.flush(w1, ENTITY);

  // Phase 2: stage the assistant reply (seq 3) + run_finished (seq 4). The
  // streams server is restarting mid-flush: seq 3 lands, seq 4's ack is lost.
  const w2 = world.ctx({ invocationId: "w2" });
  await outbox.stage(w2, ENTITY, [assistantMessageInit("pong"), runFinishedInit]);
  server.planFaults(["ok", "fail-after-apply"]);
  const flushErr = await outbox.flush(w2, ENTITY).then(
    () => null,
    (e: unknown) => e,
  );

  // The restart recovers durable RECORDS but rolls producer-dedup state back to
  // seq 3 (the debounced-checkpoint crash window, A6 #2).
  server.restart({ rollbackProducersTo: 3 });

  // Recovery: the outbox replays from the first-unconfirmed (seq 3). seq 3
  // dedups; seq 4 is RE-ADMITTED as a duplicate record (producer thinks it's
  // new). The stream now carries a duplicate seq-4 record.
  const recovery = world.ctx({ invocationId: "w2-recovery" });
  const resumed = await outbox.flush(recovery, ENTITY);

  return { server, path, flushErr, resumed, raw: server.timeline(path) };
}

describe("projection continuity through a streams-server restart — offline", () => {
  it("outbox replays from first-unconfirmed; the reader sees zero seq gaps", async () => {
    const { server, path, flushErr, resumed, raw } = await runContinuityRestart();

    expect(flushErr).toBeInstanceOf(Error);
    expect(resumed.headSeq).toBe(4);

    // The RAW stream carries a duplicate seq-4 record (A6 #2 readmission).
    expect(raw.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4, 4]);
    expect(checkSeqContiguity(raw).ok).toBe(false); // raw is NOT gapless (a dup, not a gap)

    // The reader deduped by canonical seq is gapless with no drift (D3).
    const deduped = server.dedupBySeq(path);
    expect(deduped.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4]);
    expect(checkSeqContiguity(deduped).ok).toBe(true);
    expectInvariant(PROJECTION_CONTINUITY.check(deduped, { expectedFirstSeq: 0 }));

    // The REAL frontend reducer, fed the raw stream, drops the duplicate and
    // reports no drift — the continuity guarantee end-users see.
    const state = applyTimelineEvents(initialTimelineState(), raw);
    expect(state.drift).toBeNull();
    expect(state.appliedThroughSeq).toBe(4);
    expect(state.duplicatesDropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Live end-to-end (skip-guarded on TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const stack = readStackConfig();

describe.skipIf(stack === null)(
  `projection continuity — live e2e [${stack?.baseUrl ?? SKIP_MESSAGE}]`,
  () => {
    it("a live entity's timeline stays gapless through a streams-server restart", async () => {
      // NOTE: restarting the streams container is an out-of-band operation the
      // operator triggers between the two observations (see README). This test
      // asserts the reader-visible invariant on both sides of that restart.
      const driver = createLiveDriver(stack!);
      const spawned = await driver.actions.spawn({ type: stack!.agentTypes.echo });
      await driver.actions.send(spawned.url, { text: "one" });
      const events = await driver.observeUntil(spawned.streamUrl, (evs) =>
        evs.some((e) => e.type === "run_finished"),
      );
      // observeUntil rejects on drift; a clean resolve already means gapless.
      expectInvariant(PROJECTION_CONTINUITY.check(events, { expectedFirstSeq: 0 }));
    });
  },
);
