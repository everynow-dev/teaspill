/**
 * T5.2 CONFORMANCE TESTS — written FIRST, before the reducer implementation
 * (PLAN §5 T5.2 anticipate: "write the conformance test first").
 *
 * The properties under test, in D/A-decision terms:
 *
 *  1. MID-STREAM JOIN (A7/A5): a client initialized from snapshot(seq=N) that
 *     then consumes N+1..N+k materializes the same state as a full replay
 *     from seq 0 of the same logical history — same fold position, same
 *     entity state, and identical collections over the post-join window.
 *  2. SEQ IDEMPOTENCY (A6): a server crash can readmit an already-acked
 *     append as a same-seq duplicate record; re-applying any event with
 *     seq <= appliedThroughSeq is a no-op (and is NOT drift).
 *  3. FINALIZED-WINS (deltas.ts contract): delta chunks for ref R are
 *     superseded the moment the finalized timeline event with id == R lands;
 *     late chunks for a finalized ref are dropped.
 *  4. DRIFT (D3/A1): a true seq gap surfaces `drift`; the ONLY sanctioned
 *     discontinuity is a `state_snapshot` with `historyHole: true`
 *     (docs/streams.md §3 — no gap-check across a history hole).
 *  5. OUT-OF-SNAPSHOT JOIN: joining with `fromSnapshot` when the promised
 *     snapshot record is absent is drift, not silence.
 */

import { describe, expect, it } from "vitest";
import {
  checkSeqContiguity,
  checkTimelineInvariants,
  fastJoinFromSeq,
  selectFastJoinSnapshot,
} from "@teaspill/schema";
import {
  applyDeltaRecord,
  applyDeltaRecords,
  applyTimelineEvent,
  applyTimelineEvents,
  initialTimelineState,
  type TimelineState,
} from "./reducer.js";
import {
  FIXTURE_SNAPSHOT_SEQ,
  FIXTURE_SNAPSHOT_STATE,
  delta,
  evt,
  fullHistory,
  historyHoleSnapshot,
  postSnapshotEvents,
  snapshotEvent,
  usageDelta,
} from "./fixtures.js";

const N = FIXTURE_SNAPSHOT_SEQ;

function fullReplay(): TimelineState {
  return applyTimelineEvents(initialTimelineState(), fullHistory());
}

function snapshotJoin(): TimelineState {
  // Exactly what a fast-joiner feeds the reducer: the snapshot record at the
  // catalog's snapshot_offset, then the tail (A7).
  return applyTimelineEvents(initialTimelineState({ fromSnapshot: { seq: N } }), [
    snapshotEvent(),
    ...postSnapshotEvents(),
  ]);
}

/** Restrict seq-positioned collections to the post-join window (seq > n). */
function windowed(state: TimelineState, n: number) {
  return {
    runs: state.runs.filter((r) => (r.startedSeq ?? Infinity) > n),
    messages: state.messages.filter((m) => m.seq > n),
    toolCalls: state.toolCalls.filter((t) => (t.callSeq ?? t.resultSeq ?? Infinity) > n),
    reasoning: state.reasoning.filter((r) => r.seq > n),
    errors: state.errors.filter((e) => e.seq > n),
    controls: state.controls.filter((c) => c.seq > n),
    children: state.children.filter((c) => (c.spawnedSeq ?? Infinity) > n),
  };
}

// ---------------------------------------------------------------------------
// Fixture sanity — the fixtures themselves obey the frozen invariants
// ---------------------------------------------------------------------------

describe("fixtures", () => {
  it("form a gapless 0-based timeline that satisfies the frozen invariants", () => {
    const events = fullHistory();
    expect(checkSeqContiguity(events)).toEqual({ ok: true });
    expect(checkTimelineInvariants(events)).toEqual([]);
  });

  it("fast-join helpers agree on the fixture snapshot", () => {
    const snap = selectFastJoinSnapshot([{ seq: N }]);
    expect(snap).toEqual({ seq: N });
    expect(fastJoinFromSeq(snap)).toBe(N + 1);
    expect(postSnapshotEvents()[0]!.seq).toBe(N + 1);
    expect(
      checkSeqContiguity(postSnapshotEvents(), { expectedFirstSeq: fastJoinFromSeq(snap) }),
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 1. Mid-stream join correctness (THE conformance property, A7)
// ---------------------------------------------------------------------------

describe("mid-stream join (snapshot@N then N+1..N+k)", () => {
  it("reaches the same fold position and entity state as a full replay", () => {
    const full = fullReplay();
    const joined = snapshotJoin();

    expect(joined.appliedThroughSeq).toBe(full.appliedThroughSeq);
    expect(joined.appliedThroughSeq).toBe(fullHistory().at(-1)!.seq);
    expect(joined.entityState).toEqual(FIXTURE_SNAPSHOT_STATE);
    expect(joined.entityState).toEqual(full.entityState);
    expect(joined.entityStateSeq).toBe(N);
    expect(joined.drift).toBeNull();
    expect(full.drift).toBeNull();
    expect(joined.historyHole).toBe(false);
  });

  it("materializes the post-join window identically to a full replay", () => {
    const full = fullReplay();
    const joined = snapshotJoin();
    expect(windowed(joined, N)).toEqual(windowed(full, N));
    // The joiner's collections contain ONLY the post-join window (pre-N
    // history is available via a separate full read, not invented from the
    // snapshot's opaque state).
    expect(joined.messages.every((m) => m.seq > N)).toBe(true);
    expect(joined.runs.every((r) => (r.startedSeq ?? 0) > N)).toBe(true);
  });

  it("join mode is recorded and completed", () => {
    const joined = snapshotJoin();
    expect(joined.join).toEqual({ mode: "snapshot", seq: N, complete: true });
    expect(fullReplay().join).toEqual({ mode: "replay" });
  });

  it("tolerates a read offset earlier than the snapshot (skips pre-join records)", () => {
    // A catalog byte-offset may land a few records early; everything with
    // seq < N is skipped, the snapshot still initializes, the tail applies.
    const history = fullHistory();
    const state = applyTimelineEvents(
      initialTimelineState({ fromSnapshot: { seq: N } }),
      history.slice(12), // seq 12,13,14, snapshot@15, 16..24
    );
    expect(state.skippedPreJoin).toBe(3);
    expect(state.drift).toBeNull();
    expect(state.appliedThroughSeq).toBe(history.at(-1)!.seq);
    expect(windowed(state, N)).toEqual(windowed(fullReplay(), N));
  });

  it("an orphan tool_result after the join point is kept (call was pre-snapshot)", () => {
    // A run spanning the snapshot: the tool_call landed before N, the result
    // after. The joiner must not lose the result nor crash on the missing call.
    const orphanResult = evt(N + 1, {
      type: "tool_result",
      payload: {
        runId: "run-x",
        toolUseId: "t-pre",
        content: [{ type: "text", text: "late result" }],
        isError: false,
      },
    });
    const state = applyTimelineEvents(initialTimelineState({ fromSnapshot: { seq: N } }), [
      snapshotEvent(),
      orphanResult,
    ]);
    expect(state.drift).toBeNull();
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]).toMatchObject({
      toolUseId: "t-pre",
      resultSeq: N + 1,
      result: { isError: false },
    });
    expect(state.toolCalls[0]!.callSeq).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Seq idempotency (A6 duplicate readmission)
// ---------------------------------------------------------------------------

describe("duplicate records (A6: readers dedup by embedded canonical seq)", () => {
  it("re-applying the same seq (adjacent readmission) is a no-op and not drift", () => {
    const history = fullHistory();
    const withDup = [...history.slice(0, 19), history[18]!, ...history.slice(19)];
    const clean = fullReplay();
    const dup = applyTimelineEvents(initialTimelineState(), withDup);
    expect(dup.duplicatesDropped).toBe(1);
    expect(dup.drift).toBeNull();
    expect({ ...dup, duplicatesDropped: 0 }).toEqual({ ...clean, duplicatesDropped: 0 });
  });

  it("a stale duplicate arriving much later is also dropped", () => {
    const history = fullHistory();
    const state0 = applyTimelineEvents(initialTimelineState(), history);
    const state1 = applyTimelineEvent(state0, history[3]!); // seq 3 again
    expect(state1.duplicatesDropped).toBe(1);
    expect(state1.drift).toBeNull();
    expect({ ...state1, duplicatesDropped: 0 }).toEqual({ ...state0, duplicatesDropped: 0 });
  });

  it("applyTimelineEvent is idempotent for every event in the history", () => {
    // Fold with each event applied twice ≡ fold with each applied once.
    const twice = fullHistory().flatMap((e) => [e, e]);
    const state = applyTimelineEvents(initialTimelineState(), twice);
    const clean = fullReplay();
    expect(state.duplicatesDropped).toBe(fullHistory().length);
    expect({ ...state, duplicatesDropped: 0 }).toEqual({ ...clean, duplicatesDropped: 0 });
  });
});

// ---------------------------------------------------------------------------
// 3. Delta interleaving — finalized event always wins
// ---------------------------------------------------------------------------

describe("delta interleaving (finalized wins)", () => {
  const baseState = () =>
    applyTimelineEvents(
      initialTimelineState(),
      fullHistory().filter((e) => e.seq <= 17), // run C started, m-c1 not yet finalized
    );

  it("chunks accumulate per ref in idx order (out-of-order arrival, gaps allowed)", () => {
    let s = baseState();
    s = applyDeltaRecords(s, [
      delta({ kind: "text", ref: "m-c1", idx: 2, text: " you" }),
      delta({ kind: "text", ref: "m-c1", idx: 0, text: "here" }),
      // idx 1 dropped in transit — a gap is normal, not drift
      delta({ kind: "text", ref: "m-c1", idx: 4, text: " go" }),
    ]);
    expect(s.liveDeltas["m-c1"]).toMatchObject({
      ref: "m-c1",
      kind: "text",
      text: "here you go",
    });
    expect(s.drift).toBeNull();
  });

  it("duplicate idx for the same ref is dropped (first wins)", () => {
    let s = baseState();
    s = applyDeltaRecords(s, [
      delta({ kind: "text", ref: "m-c1", idx: 0, text: "here" }),
      delta({ kind: "text", ref: "m-c1", idx: 0, text: "HERE-AGAIN" }),
    ]);
    expect(s.liveDeltas["m-c1"]!.text).toBe("here");
  });

  it("the finalized message supersedes buffered deltas for its ref", () => {
    let s = baseState();
    s = applyDeltaRecords(s, [
      delta({ kind: "text", ref: "m-c1", idx: 0, text: "here" }),
      delta({ kind: "text", ref: "m-c1", idx: 1, text: " you go" }),
    ]);
    expect(s.liveDeltas["m-c1"]).toBeDefined();
    const finalized = fullHistory().find((e) => e.seq === 20)!; // message m-c1
    s = applyTimelineEvent(s, finalized);
    expect(s.liveDeltas["m-c1"]).toBeUndefined(); // superseded
    expect(s.messages.some((m) => m.id === "m-c1")).toBe(true);
  });

  it("a late chunk for an already-finalized ref is dropped immediately", () => {
    let s = baseState();
    s = applyTimelineEvent(
      s,
      fullHistory().find((e) => e.seq === 20)!,
    ); // finalize m-c1
    s = applyDeltaRecord(s, delta({ kind: "text", ref: "m-c1", idx: 5, text: "straggler" }));
    expect(s.liveDeltas["m-c1"]).toBeUndefined();
    expect(s.deltasDropped).toBeGreaterThanOrEqual(1);
  });

  it("finalized reasoning and tool_call supersede their delta refs too", () => {
    let s = baseState();
    s = applyDeltaRecords(s, [
      delta({ kind: "reasoning", ref: "r2", idx: 0, text: "thinking…" }),
      delta({ kind: "tool_input", ref: "t2", idx: 0, text: '{"path":' }),
    ]);
    expect(s.liveDeltas["r2"]).toBeDefined();
    expect(s.liveDeltas["t2"]).toBeDefined();
    s = applyTimelineEvent(
      s,
      fullHistory().find((e) => e.seq === 18)!,
    ); // tool_call t2
    expect(s.liveDeltas["t2"]).toBeUndefined();
    s = applyTimelineEvent(
      s,
      fullHistory().find((e) => e.seq === 21)!,
    ); // reasoning r2
    expect(s.liveDeltas["r2"]).toBeUndefined();
  });

  it("a higher Restate attempt resets the buffer; lower-attempt stragglers drop (T7.4)", () => {
    let s = baseState();
    s = applyDeltaRecords(s, [
      delta({ kind: "text", ref: "m-c1", idx: 0, text: "first attempt", attempt: 0 }),
      delta({ kind: "text", ref: "m-c1", idx: 0, text: "retry", attempt: 1 }),
      delta({ kind: "text", ref: "m-c1", idx: 1, text: " straggler", attempt: 0 }),
    ]);
    expect(s.liveDeltas["m-c1"]).toMatchObject({ attempt: 1, text: "retry" });
  });

  it("usage deltas (ref = runId) are superseded by run_finished", () => {
    let s = baseState();
    s = applyDeltaRecord(s, usageDelta({ ref: "run-c", idx: 0, usage: { outputTokens: 10 } }));
    expect(s.liveUsage["run-c"]).toMatchObject({ usage: { outputTokens: 10 } });
    for (const e of fullHistory().filter((e) => e.seq > 17 && e.seq <= 22)) {
      s = applyTimelineEvent(s, e); // …through run_finished(run-c)
    }
    expect(s.liveUsage["run-c"]).toBeUndefined();
    expect(s.runs.find((r) => r.runId === "run-c")?.usage).toMatchObject({ outputTokens: 60 });
  });

  it("run_finished sweeps any leftover live deltas of that run", () => {
    let s = baseState();
    s = applyDeltaRecord(s, delta({ kind: "text", ref: "m-orphaned", idx: 0, text: "partial" }));
    for (const e of fullHistory().filter((e) => e.seq > 17 && e.seq <= 22)) {
      s = applyTimelineEvent(s, e);
    }
    // m-orphaned never finalized (trailing partial lost on interrupt — D5),
    // but its run is over: nothing should keep streaming-state alive.
    expect(s.liveDeltas["m-orphaned"]).toBeUndefined();
  });

  it("a chunk arriving AFTER its run finished is dropped (any ref)", () => {
    // The /deltas session is a separate connection: its batches can land
    // after the timeline already applied run_finished. Stale on arrival.
    let s = applyTimelineEvents(
      initialTimelineState(),
      fullHistory().filter((e) => e.seq <= 22), // run-c finished at 22
    );
    s = applyDeltaRecord(s, delta({ kind: "text", ref: "m-late", idx: 0, text: "too late" }));
    expect(s.liveDeltas["m-late"]).toBeUndefined();
    expect(s.deltasDropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Drift detection (true gap) vs sanctioned discontinuities
// ---------------------------------------------------------------------------

describe("seq-gap drift detector (D3/A1)", () => {
  it("a gap surfaces drift with the expected/got pair", () => {
    const history = fullHistory();
    const gapped = [...history.slice(0, 6), ...history.slice(7)]; // seq 6 missing
    const state = applyTimelineEvents(initialTimelineState(), gapped);
    expect(state.drift).toMatchObject({ kind: "gap", expectedSeq: 6, gotSeq: 7 });
    expect(state.driftCount).toBe(1);
    // Resync-and-continue policy: later contiguous events still apply.
    expect(state.appliedThroughSeq).toBe(history.at(-1)!.seq);
  });

  it("a duplicate is NOT drift (A6 distinguishes readmission from a gap)", () => {
    const history = fullHistory();
    const withDup = [...history.slice(0, 10), history[9]!, ...history.slice(10)];
    const state = applyTimelineEvents(initialTimelineState(), withDup);
    expect(state.drift).toBeNull();
    expect(state.driftCount).toBe(0);
    expect(state.duplicatesDropped).toBe(1);
  });

  it("a historyHole snapshot is a sanctioned jump, not drift (docs/streams.md §3)", () => {
    const history = fullHistory();
    const state = applyTimelineEvents(initialTimelineState(), [
      ...history.slice(0, 6), // seq 0..5
      historyHoleSnapshot(10), // jump: 6..9 lost (D3 recovery)
      evt(11, {
        type: "run_started",
        payload: { runId: "run-after-hole", wake: { source: "system" }, harness: "native" },
      }),
    ]);
    expect(state.drift).toBeNull();
    expect(state.historyHole).toBe(true);
    expect(state.appliedThroughSeq).toBe(11);
    expect(state.entityState).toEqual({ recovered: true });
  });

  it("a NON-hole snapshot arriving past a gap is still drift (then resyncs)", () => {
    const history = fullHistory();
    const state = applyTimelineEvents(initialTimelineState(), [
      ...history.slice(0, 6), // 0..5
      history[FIXTURE_SNAPSHOT_SEQ]!, // periodic snapshot @15 — gap 6..14
    ]);
    expect(state.drift).toMatchObject({ kind: "gap", expectedSeq: 6, gotSeq: 15 });
    expect(state.appliedThroughSeq).toBe(15); // resynced at the snapshot
    expect(state.entityState).toEqual(FIXTURE_SNAPSHOT_STATE);
  });
});

// ---------------------------------------------------------------------------
// 5. Out-of-snapshot join (promised snapshot absent)
// ---------------------------------------------------------------------------

describe("out-of-snapshot join", () => {
  it("joining without fromSnapshot replays from 0 (join point = fastJoinFromSeq(null))", () => {
    expect(fastJoinFromSeq(null)).toBe(0);
    const state = fullReplay();
    expect(state.join).toEqual({ mode: "replay" });
    expect(state.appliedThroughSeq).toBe(fullHistory().at(-1)!.seq);
  });

  it("fromSnapshot whose snapshot record never appears is drift, loudly", () => {
    const state = applyTimelineEvents(
      initialTimelineState({ fromSnapshot: { seq: N } }),
      postSnapshotEvents(), // starts at N+1: the snapshot@N itself is missing
    );
    expect(state.drift).toMatchObject({ kind: "missing_join_snapshot", expectedSeq: N });
    // Still resyncs so the UI shows the live tail rather than nothing.
    expect(state.appliedThroughSeq).toBe(fullHistory().at(-1)!.seq);
  });

  it("fromSnapshot pointing at a non-snapshot seq is drift", () => {
    const state = applyTimelineEvents(
      initialTimelineState({ fromSnapshot: { seq: 16 } }), // seq 16 is run_started
      fullHistory().filter((e) => e.seq >= 16),
    );
    expect(state.drift).toMatchObject({ kind: "missing_join_snapshot", expectedSeq: 16 });
  });
});
