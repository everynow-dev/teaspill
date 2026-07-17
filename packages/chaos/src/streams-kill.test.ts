/**
 * FAULT 3 — streams server killed.
 *
 * INVARIANT (assert this, not "no crash"): with the durable-streams server dead,
 * runs PROCEED (control flow is Restate K/V, never the stream — D1) and deltas
 * drop; on streams recovery the outbox replays from the FIRST-UNCONFIRMED seq and
 * the reader — deduping by canonical seq — sees a gapless timeline with ZERO seq
 * gaps (A6 replay-from-first-unconfirmed). This is the `projection-continuity`
 * conformance scenario with the streams outage placed mid-flush.
 *
 * OFFLINE (CI): the REAL projection outbox over conformance's faithful fake
 * streams server. A flush is interrupted by the streams server dying (ack lost
 * on seq 4), then a restart that rolls the DEBOUNCED producer-dedup state back to
 * an earlier checkpoint (A6 #2). On recovery the outbox replays from the first
 * unconfirmed; the server re-admits an already-acked append as a DUPLICATE
 * RECORD, and the reader (deduped by canonical seq) still sees zero gaps. The
 * REAL frontend reducer, fed the raw stream, drops the duplicate and reports no
 * drift — re-asserted with `assertSeqGapless` + the scenario `check`.
 *
 * The "runs PROCEED while streams is down" half (D1) is shown by the outbox
 * error NOT corrupting the K/V: the seq counter is intact and the retry
 * completes — coordination never blocked on the stream.
 *
 * LIVE (gated): kill the streams container mid-run, let the run proceed, bring
 * streams back, and re-assert zero seq gaps on the recovered timeline.
 */

import { describe, expect, it } from "vitest";
import { DurableStreamsProjectionOutbox, timelineStreamPath } from "@teaspill/coordination";
import {
  applyTimelineEvents,
  checkSeqContiguity,
  initialTimelineState,
} from "@teaspill/frontend-sdk";
import {
  MemoryWorld,
  FakeStreamsServer,
  assertSeqGapless,
  scenarioById,
  expectInvariant,
  createLiveDriver,
} from "@teaspill/conformance";
import { STREAMS_KILL } from "./faults.js";
import { readChaosConfig, CHAOS_SKIP_MESSAGE } from "./env.js";
import {
  assistantMessageInit,
  runFinishedInit,
  runStartedInit,
  spawnedInit,
  userMessageInit,
} from "./fixtures.js";

const ENTITY = "/t/default/a/conformance-echo/chaos-streams";
const PROJECTION_CONTINUITY = scenarioById(STREAMS_KILL.scenarioId);

async function runStreamsKillRecovery() {
  const world = new MemoryWorld("chaos-streams");
  const server = new FakeStreamsServer();
  const outbox = new DurableStreamsProjectionOutbox({ transport: server });
  const path = timelineStreamPath(ENTITY);

  // Phase 1: spawn + run_started + user message — cleanly confirmed (seq 0..2).
  const w1 = world.ctx({ invocationId: "w1" });
  await outbox.stage(w1, ENTITY, [spawnedInit, runStartedInit, userMessageInit("ping")]);
  await outbox.flush(w1, ENTITY);

  // Phase 2: the run keeps going (control flow is K/V, not the stream — D1) and
  // stages the assistant reply (seq 3) + run_finished (seq 4). The streams
  // server is DYING mid-flush: seq 3 lands, seq 4's ack is lost.
  const w2 = world.ctx({ invocationId: "w2" });
  await outbox.stage(w2, ENTITY, [assistantMessageInit("pong"), runFinishedInit]);
  server.planFaults(["ok", "fail-after-apply"]);
  const flushErr = await outbox.flush(w2, ENTITY).then(
    () => null,
    (e: unknown) => e,
  );

  // Streams server RESTART: durable RECORDS survive, but producer-dedup rolls
  // back to seq 3 (the debounced-checkpoint crash window, A6 #2).
  server.restart({ rollbackProducersTo: 3 });

  // Recovery: replay from the first unconfirmed (seq 3). seq 3 dedups; seq 4 is
  // RE-ADMITTED as a duplicate record. The stream now carries a duplicate seq-4.
  const recovery = world.ctx({ invocationId: "w2-recovery" });
  const resumed = await outbox.flush(recovery, ENTITY);

  return { world, server, path, flushErr, resumed, raw: server.timeline(path) };
}

describe("FAULT 3 — streams server killed — offline (outbox replay, zero seq gaps)", () => {
  it("runs proceed (K/V uncorrupted) and the recovered reader sees ZERO seq gaps", async () => {
    const { world, server, path, flushErr, resumed, raw } = await runStreamsKillRecovery();

    // The streams outage surfaced as a flush error — but the RUN proceeded: the
    // K/V seq counter is intact (D1, coordination never blocked on the stream).
    expect(flushErr).toBeInstanceOf(Error);
    expect(world.kv<number>("seq")).toBe(5); // 5 events staged (seq 0..4)
    expect(resumed.headSeq).toBe(4); // recovery completed the flush

    // The RAW stream carries a duplicate seq-4 record (A6 #2 readmission)…
    expect(raw.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4, 4]);
    expect(checkSeqContiguity(raw).ok).toBe(false); // a dup, not a gap

    // …but the reader deduped by canonical seq is gapless with no drift (D3).
    const deduped = server.dedupBySeq(path);
    expect(deduped.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4]);
    expectInvariant(assertSeqGapless(deduped, { expectedFirstSeq: 0 }));
    expectInvariant(PROJECTION_CONTINUITY.check(deduped, { expectedFirstSeq: 0 }));

    // The REAL frontend reducer, fed the raw stream, drops the duplicate and
    // reports NO drift — the zero-seq-gap guarantee end-users see.
    const state = applyTimelineEvents(initialTimelineState(), raw);
    expect(state.drift).toBeNull();
    expect(state.appliedThroughSeq).toBe(4);
    expect(state.duplicatesDropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LIVE chaos (gated on TEASPILL_CHAOS + TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const chaos = readChaosConfig();

describe.skipIf(chaos === null)(
  `FAULT 3 — streams server killed — LIVE [${chaos?.stack.baseUrl ?? CHAOS_SKIP_MESSAGE}]`,
  () => {
    it("kill streams mid-run; the run proceeds and the recovered timeline is gapless", async () => {
      const { stack, compose, services } = chaos!;
      const driver = createLiveDriver(stack);
      const spawned = await driver.actions.spawn({ type: stack.agentTypes.echo });

      // Inject the fault: kill the streams server. The run must PROCEED (D1) —
      // coordination reads/writes only Restate K/V while streams is down.
      compose.kill(services.streams);
      await driver.actions.send(spawned.url, { text: "ping" });

      // Bring streams back; the outbox replays from first-unconfirmed on the
      // next flush. The reader must see ZERO seq gaps across the whole outage.
      compose.start(services.streams);
      await compose.waitHealthy(services.streams, 30_000);

      const events = await driver.observeUntil(
        spawned.streamUrl,
        (evs) => evs.some((e) => e.type === "run_finished"),
        { timeoutMs: Math.max(stack.timeoutMs, 60_000) },
      );
      // observeUntil rejects on drift (a seq gap) — a clean resolve IS the
      // zero-gap invariant; re-assert exactly-once + gapless explicitly too.
      expectInvariant(PROJECTION_CONTINUITY.check(events, { expectedFirstSeq: 0 }));
    });
  },
);
