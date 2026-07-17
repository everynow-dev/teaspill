/**
 * Canned canonical-event fixtures for the T5.2 conformance tests (and reusable
 * by the T6.3 conformance kit). Everything is built through the FROZEN v1
 * schema's own `finalizeEvent` (DECISIONS A5) so a fixture can never drift
 * from the schema: an invalid fixture throws at construction time.
 *
 * The main fixture is one "logical history" for a single entity:
 *
 *   seq 0        entity_spawned
 *   seq 1..7     run A   (user msg, assistant msg, tool call/result, assistant msg)
 *   seq 8..9     child spawned + finished
 *   seq 10..14   run B   (reasoning, assistant msg, summarization)
 *   seq 15       state_snapshot (periodic)          <-- the fast-join point N
 *   seq 16..24   run C + control/error tail         <-- the post-join window
 *
 * A mid-stream joiner (A7) loads snapshot@15 then consumes 16, 17, … — the
 * conformance test asserts that fold equals a full replay from 0.
 */

import {
  finalizeEvent,
  parseDeltaRecord,
  type DeltaRecord,
  type JsonValue,
  type StateSnapshotEvent,
  type TimelineEvent,
  type TimelineEventInit,
} from "@teaspill/schema";

export const FIXTURE_ENTITY_ID = "/t/default/a/researcher/01test0000000000000000000000";

/** Deterministic per-seq timestamp so fixtures are stable across runs. */
export function fixtureTs(seq: number): string {
  return new Date(Date.UTC(2026, 6, 17, 12, 0, 0) + seq * 1000).toISOString();
}

/** Finalize one fixture event (validates against the frozen schema). */
export function evt(seq: number, init: Omit<TimelineEventInit, "ts">): TimelineEvent {
  return finalizeEvent({ ...init, ts: fixtureTs(seq) } as TimelineEventInit, {
    entityId: FIXTURE_ENTITY_ID,
    seq,
  });
}

/** The seq of the periodic `state_snapshot` in the canonical fixture history. */
export const FIXTURE_SNAPSHOT_SEQ = 15;

/** The opaque entity state the fixture snapshot asserts as of seq 15. */
export const FIXTURE_SNAPSHOT_STATE: JsonValue = {
  status: "idle",
  context: [{ role: "assistant", text: "summary of runs A and B" }],
  workspaceRef: "default/a-researcher-01test0000000000000000000000",
};

/**
 * The canonical full history, seq 0..24, gapless (A1). The snapshot at seq 15
 * is a normal record occupying its seq slot (docs/streams.md §3).
 */
export function fullHistory(): TimelineEvent[] {
  const events: TimelineEvent[] = [
    evt(0, {
      type: "entity_spawned",
      payload: { entityType: "researcher", parentId: null, spawnArgs: { topic: "tea" } },
    }),
    // -- run A ------------------------------------------------------------
    evt(1, {
      type: "run_started",
      payload: { runId: "run-a", wake: { source: "spawn" }, harness: "native", model: "m-1" },
    }),
    evt(2, {
      type: "message",
      payload: {
        id: "m-u1",
        runId: "run-a",
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    }),
    evt(3, {
      type: "message",
      payload: {
        id: "m-a1",
        runId: "run-a",
        role: "assistant",
        content: [{ type: "text", text: "hello — let me check" }],
      },
    }),
    evt(4, {
      type: "tool_call",
      payload: { runId: "run-a", toolUseId: "t1", name: "bash", input: { cmd: "ls" } },
    }),
    evt(5, {
      type: "tool_result",
      payload: {
        runId: "run-a",
        toolUseId: "t1",
        name: "bash",
        content: [{ type: "text", text: "README.md" }],
        detail: { exitCode: 0 },
        isError: false,
      },
    }),
    evt(6, {
      type: "message",
      payload: {
        id: "m-a2",
        runId: "run-a",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    }),
    evt(7, {
      type: "run_finished",
      payload: {
        runId: "run-a",
        outcome: "success",
        usage: { inputTokens: 100, outputTokens: 50, steps: 2 },
        durationMs: 1200,
      },
    }),
    // -- child ------------------------------------------------------------
    evt(8, {
      type: "child_spawned",
      payload: {
        childId: "/t/default/a/worker/01child000000000000000000000",
        childType: "worker",
      },
    }),
    evt(9, {
      type: "child_finished",
      payload: {
        childId: "/t/default/a/worker/01child000000000000000000000",
        outcome: "success",
        result: { ok: true },
      },
    }),
    // -- run B ------------------------------------------------------------
    evt(10, {
      type: "run_started",
      payload: {
        runId: "run-b",
        wake: { source: "message", from: "/t/default/a/worker/01child000000000000000000000" },
        harness: "native",
      },
    }),
    evt(11, {
      type: "reasoning",
      payload: { id: "r1", runId: "run-b", text: "thinking about the child result" },
    }),
    evt(12, {
      type: "message",
      payload: {
        id: "m-b1",
        runId: "run-b",
        role: "assistant",
        content: [{ type: "text", text: "child finished fine" }],
      },
    }),
    evt(13, {
      type: "summarization",
      payload: { runId: "run-b", summary: "runs A and B condensed", replacesThroughSeq: 6 },
    }),
    evt(14, {
      type: "run_finished",
      payload: {
        runId: "run-b",
        outcome: "success",
        usage: { inputTokens: 80, outputTokens: 20 },
      },
    }),
    // -- the fast-join snapshot (A7) --------------------------------------
    evt(FIXTURE_SNAPSHOT_SEQ, {
      type: "state_snapshot",
      payload: { state: FIXTURE_SNAPSHOT_STATE, reason: "periodic" },
    }),
    // -- run C (the post-join window) --------------------------------------
    evt(16, {
      type: "run_started",
      payload: { runId: "run-c", wake: { source: "message" }, harness: "casdk", model: "m-2" },
    }),
    evt(17, {
      type: "message",
      payload: {
        id: "m-u2",
        runId: "run-c",
        role: "user",
        content: [{ type: "text", text: "and now?" }],
      },
    }),
    evt(18, {
      type: "tool_call",
      payload: { runId: "run-c", toolUseId: "t2", name: "read_file", input: { path: "a.txt" } },
    }),
    evt(19, {
      type: "tool_result",
      payload: {
        runId: "run-c",
        toolUseId: "t2",
        content: [{ type: "text", text: "contents" }],
        isError: false,
      },
    }),
    evt(20, {
      type: "message",
      payload: {
        id: "m-c1",
        runId: "run-c",
        role: "assistant",
        content: [{ type: "text", text: "here you go" }],
      },
    }),
    evt(21, {
      type: "reasoning",
      payload: { id: "r2", runId: "run-c", text: "post-join thought" },
    }),
    evt(22, {
      type: "run_finished",
      payload: {
        runId: "run-c",
        outcome: "success",
        usage: { inputTokens: 120, outputTokens: 60, contextTokens: 4000, attempt: 0 },
      },
    }),
    evt(23, {
      type: "error",
      payload: { runId: "run-c", message: "post-run warning", source: "platform" },
    }),
    evt(24, { type: "control", payload: { verb: "pause", from: "/api" } }),
  ];
  return events;
}

/** The `state_snapshot` event at seq 15 (the A7 join point). */
export function snapshotEvent(): StateSnapshotEvent {
  const ev = fullHistory()[FIXTURE_SNAPSHOT_SEQ]!;
  if (ev.type !== "state_snapshot") throw new Error("fixture broke: seq 15 is not the snapshot");
  return ev;
}

/** Events with seq > FIXTURE_SNAPSHOT_SEQ (the joiner's consume window). */
export function postSnapshotEvents(): TimelineEvent[] {
  return fullHistory().filter((e) => e.seq > FIXTURE_SNAPSHOT_SEQ);
}

/** A recovery snapshot with a history hole at an arbitrary seq (D3 path). */
export function historyHoleSnapshot(seq: number): TimelineEvent {
  return evt(seq, {
    type: "state_snapshot",
    payload: { state: { recovered: true }, reason: "recovery", historyHole: true },
  });
}

// ---------------------------------------------------------------------------
// Delta fixtures (sibling `/deltas` stream records — no seq, ref-addressed)
// ---------------------------------------------------------------------------

export function delta(
  init: {
    kind: "text" | "reasoning" | "tool_input";
    ref: string;
    idx: number;
    text: string;
    runId?: string;
    attempt?: number;
  },
  ts = fixtureTs(100),
): DeltaRecord {
  return parseDeltaRecord({
    v: 1,
    entityId: FIXTURE_ENTITY_ID,
    runId: init.runId ?? "run-c",
    ...(init.attempt !== undefined ? { attempt: init.attempt } : {}),
    ref: init.ref,
    idx: init.idx,
    ts,
    kind: init.kind,
    text: init.text,
  });
}

export function usageDelta(
  init: { ref: string; idx: number; runId?: string; attempt?: number; usage: object },
  ts = fixtureTs(100),
): DeltaRecord {
  return parseDeltaRecord({
    v: 1,
    entityId: FIXTURE_ENTITY_ID,
    runId: init.runId ?? "run-c",
    ...(init.attempt !== undefined ? { attempt: init.attempt } : {}),
    ref: init.ref,
    idx: init.idx,
    ts,
    kind: "usage",
    usage: init.usage,
  });
}
