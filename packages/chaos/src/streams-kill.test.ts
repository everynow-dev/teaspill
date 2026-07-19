/**
 * FAULT 3 — streams server killed.
 *
 * INVARIANT (assert this, not "no crash"): with the durable-streams server dead,
 * runs PROCEED (control flow is Restate K/V, never the stream — 0001:D1) and deltas
 * drop; on streams recovery the outbox replays from the FIRST-UNCONFIRMED seq and
 * the reader — deduping by canonical seq — sees a gapless timeline with ZERO seq
 * gaps (0001:A6 replay-from-first-unconfirmed). This is the `projection-continuity`
 * conformance scenario with the streams outage placed mid-flush.
 *
 * OFFLINE (CI): the REAL projection outbox over conformance's faithful fake
 * streams server. A flush is interrupted by the streams server dying (ack lost
 * on seq 4), then a restart that rolls the DEBOUNCED producer-dedup state back to
 * an earlier checkpoint (0001:A6 #2). On recovery the outbox replays from the first
 * unconfirmed; the server re-admits an already-acked append as a DUPLICATE
 * RECORD, and the reader (deduped by canonical seq) still sees zero gaps. The
 * REAL frontend reducer, fed the raw stream, drops the duplicate and reports no
 * drift — re-asserted with `assertSeqGapless` + the scenario `check`.
 *
 * The "runs PROCEED while streams is down" half (0001:D1) is shown by the outbox
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
  assertStructural,
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

  // Phase 2: the run keeps going (control flow is K/V, not the stream — 0001:D1) and
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
  // back to seq 3 (the debounced-checkpoint crash window, 0001:A6 #2).
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
    // K/V seq counter is intact (0001:D1, coordination never blocked on the stream).
    expect(flushErr).toBeInstanceOf(Error);
    expect(world.kv<number>("seq")).toBe(5); // 5 events staged (seq 0..4)
    expect(resumed.headSeq).toBe(4); // recovery completed the flush

    // The RAW stream carries a duplicate seq-4 record (0001:A6 #2 readmission)…
    expect(raw.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4, 4]);
    expect(checkSeqContiguity(raw).ok).toBe(false); // a dup, not a gap

    // …but the reader deduped by canonical seq is gapless with no drift (0001:D3).
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

  it("TOTAL producer-state loss (0002:T4.3 live-observed) with an UNTRIMMED outbox: replay-from-0 readmits acked appends; the reader dedup covers", async () => {
    // What the real `:0.1.4` server actually does on SIGKILL (0002:T4.3): its
    // producer-dedup state is lost ENTIRELY (records survive; every producer
    // restarts at expected-seq 0) — the extreme end of the 0001:A6#2 window the
    // partial-rollback test above models. When the outbox has NOT yet trimmed
    // (ack lost mid-batch ⇒ confirmedSeq unset), replay starts at seq 0, the
    // fresh-producer server ACCEPTS the already-recorded seqs again ⇒
    // duplicate records ⇒ the reader's canonical-seq dedup is what protects
    // end users. (The trimmed-outbox case cannot replay at all —
    // producer_gap drift ⇒ 0001:A9 recovery; regression-tested at the
    // coordination layer, driven live by this file's LIVE test.)
    const world = new MemoryWorld("chaos-streams-wipe");
    const server = new FakeStreamsServer();
    const outbox = new DurableStreamsProjectionOutbox({ transport: server });
    const entity = "/t/default/a/conformance-echo/chaos-streams-wipe";
    const path = timelineStreamPath(entity);

    // One batch staged; the server dies mid-flush AFTER applying seq 0..2
    // (ack for seq 2 lost) — nothing trimmed, confirmedSeq unset.
    const w1 = world.ctx({ invocationId: "w1" });
    await outbox.stage(w1, entity, [
      spawnedInit,
      runStartedInit,
      userMessageInit("ping"),
      assistantMessageInit("pong"),
      runFinishedInit,
    ]);
    // 4 slots: request #1 is seq 0 against the not-yet-created stream
    // (stream_not_found consumes a slot; the outbox PUT-creates and retries),
    // then seq 0, 1 apply, and seq 2 applies with its ACK LOST.
    server.planFaults(["ok", "ok", "ok", "fail-after-apply"]);
    const flushErr = await outbox.flush(w1, entity).then(
      () => null,
      (e: unknown) => e,
    );
    expect(flushErr).toBeInstanceOf(Error);
    expect(server.rawRecords(path)).toHaveLength(3); // 0..2 applied pre-crash

    // SIGKILL restart: full producer-state wipe, records intact.
    server.restart({ wipeProducers: true });

    // Retry replays from pending[0] = seq 0; the fresh producer accepts 0..2
    // AGAIN (duplicate records) and 3..4 for the first time.
    const retry = world.ctx({ invocationId: "w1-retry" });
    const resumed = await outbox.flush(retry, entity);
    expect(resumed).toStrictEqual({ appended: 5, headSeq: 4 });

    const raw = server.timeline(path);
    expect(raw.map((e) => e.seq)).toStrictEqual([0, 1, 2, 0, 1, 2, 3, 4]);

    // Reader-side: dedup by canonical seq ⇒ exactly-once, gapless, no drift.
    const deduped = server.dedupBySeq(path);
    expect(deduped.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4]);
    expectInvariant(assertSeqGapless(deduped, { expectedFirstSeq: 0 }));
    const state = applyTimelineEvents(initialTimelineState(), raw);
    expect(state.drift).toBeNull();
    expect(state.appliedThroughSeq).toBe(4);
    expect(state.duplicatesDropped).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// LIVE chaos (gated on TEASPILL_CHAOS + TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const chaos = readChaosConfig();

describe.skipIf(chaos === null)(
  `FAULT 3 — streams server killed — LIVE [${chaos?.stack.baseUrl ?? CHAOS_SKIP_MESSAGE}]`,
  () => {
    /** Fetch the RAW records (duplicates included) of a timeline through the gateway proxy. */
    async function rawSeqs(stack: NonNullable<typeof chaos>["stack"], streamUrl: string) {
      const url = streamUrl.startsWith("http") ? streamUrl : stack.baseUrl + streamUrl;
      const auth =
        stack.auth !== undefined && "apiKey" in stack.auth
          ? { authorization: `Bearer ${stack.auth.apiKey}` }
          : {};
      const res = await fetch(`${url}?offset=-1`, { headers: auth });
      if (!res.ok) throw new Error(`raw stream read failed: ${res.status}`);
      const text = await res.text();
      const seqs: number[] = [];
      for (const line of text.split("\n")) {
        const l = line.trim();
        if (l === "") continue;
        const parsed: unknown = JSON.parse(l);
        for (const rec of Array.isArray(parsed) ? parsed : [parsed]) {
          seqs.push((rec as { seq: number }).seq);
        }
      }
      return seqs;
    }

    it("kill streams mid-run; the reconciler heals the producer-state loss and the reader view is consistent", async () => {
      // 0002:T4.3 LIVE REALITY (supersedes the pre-live version of this test):
      // a SIGKILL of the real :0.1.4 server loses its producer-dedup state
      // ENTIRELY (records survive; every producer restarts at expected-seq 0).
      // For an entity whose outbox already trimmed confirmed events —
      // deterministically arranged here — replay is IMPOSSIBLE (producer_gap
      // drift, 0001:A6#3 409-with-expected-0) and the ONLY route back is the
      // 0001:A9/0001:D3 catastrophic recovery: reconciler detects → agent object
      // resets epoch/offset → state_snapshot(recovery, historyHole) bridges
      // the hole → subsequent runs proceed. That end-to-end heal is what this
      // test asserts, plus the reader-side guarantees (dedup by canonical seq,
      // the hole being the ONLY sanctioned discontinuity).
      const { stack, compose, services } = chaos!;
      const driver = createLiveDriver(stack);
      const spawned = await driver.actions.spawn({ type: stack.agentTypes.echo });

      // Ensure the spawn wake's events are CONFIRMED + TRIMMED before the kill
      // (that is what makes the post-restart producer_gap deterministic).
      await driver.observeUntil(
        spawned.streamUrl,
        (evs) => evs.some((e) => e.type === "run_finished"),
        { timeoutMs: Math.max(stack.timeoutMs, 30_000) },
      );

      // Inject the fault: kill the streams server, then send mid-outage. The
      // run PROCEEDS (0001:D1 — control flow is Restate K/V): the wake stages its
      // events and only the flush fails-and-retries while streams is down.
      compose.kill(services.streams);
      await driver.actions.send(spawned.url, { text: "ping" });

      // Bring streams back. The retried flush now hits the wiped producer
      // state (expects 0 < first pending) ⇒ OutboxDriftError(producer_gap) ⇒
      // the reconciler routes flush→recovery (0002:T2.2 loop, ≤60s interval).
      compose.start(services.streams);
      await compose.waitHealthy(services.streams, 30_000);

      // THE HEAL: a state_snapshot(recovery, historyHole) lands on the stream
      // under the bumped epoch. Window covers the reconciler interval (60s)
      // plus margin.
      const healed = await driver.observeUntil(
        spawned.streamUrl,
        (evs) =>
          evs.some(
            (e) =>
              e.type === "state_snapshot" &&
              e.payload.reason === "recovery" &&
              e.payload.historyHole === true,
          ),
        { timeoutMs: 150_000 },
      );
      const snapshot = healed.find((e) => e.type === "state_snapshot");
      expect(snapshot, "recovery snapshot").toBeDefined();

      // The entity is HEALED: a fresh send round-trips normally after the reset
      // (appends at the new epoch, affine producer-seq).
      await driver.actions.send(spawned.url, { text: "after-recovery" });
      const events = await driver.observeUntil(
        spawned.streamUrl,
        (evs) =>
          evs.some(
            (e) =>
              e.type === "message" &&
              e.payload.role === "assistant" &&
              e.payload.content.some(
                (b) => b.type === "text" && b.text.includes("after-recovery"),
              ) &&
              evs.some((f) => f.type === "run_finished" && f.payload.runId === e.payload.runId),
          ),
        { timeoutMs: Math.max(stack.timeoutMs, 60_000) },
      );

      // Reader-side invariants. observeUntil resolving cleanly already means
      // the REAL frontend reducer saw no drift — the historyHole snapshot is
      // the sanctioned re-anchor (0001:D3). Assert structure + that the hole is
      // the ONLY discontinuity, bridged exactly by the recovery snapshot.
      expectInvariant(assertStructural(events));
      const seqs = events.map((e) => e.seq);
      for (let i = 1; i < seqs.length; i++) {
        if (seqs[i]! !== seqs[i - 1]! + 1) {
          const bridging = events[i]!;
          expect(
            bridging.type === "state_snapshot" && bridging.payload.historyHole === true,
            `seq discontinuity ${seqs[i - 1]}→${seqs[i]} must be bridged by a historyHole snapshot`,
          ).toBe(true);
        }
      }
      // Exactly-once in the deduped view: no seq appears twice.
      expect(new Set(seqs).size).toBe(seqs.length);

      // 0001:A6#2 raw-vs-deduped: the RAW stream may carry duplicate records
      // (server-crash readmission window); the reader view above is already
      // deduped. Report provocation either way — this is the chaos evidence
      // for the A6#2 window.
      const raw = await rawSeqs(stack, spawned.streamUrl);
      const dupCount = raw.length - new Set(raw).size;
      // (No assertion on dupCount > 0: whether readmission occurred depends on
      // exact kill timing. The invariant is that the READER view is dup-free.)
      console.log(
        `[chaos] streams-kill raw records=${raw.length} distinct=${new Set(raw).size} ` +
          `duplicates=${dupCount} (A6#2 readmission ${dupCount > 0 ? "PROVOKED" : "not provoked this run"})`,
      );
    });
  },
);
