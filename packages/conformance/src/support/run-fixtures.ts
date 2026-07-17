/**
 * Canonical `TimelineEventInit` builders for the offline projection scenarios
 * (crash-resume, projection-continuity). These are staged through the REAL
 * `DurableStreamsProjectionOutbox`, which allocates seqs (A1) and finalizes
 * them — so the fixtures carry NO seq, exactly like harness output.
 */

import type { TimelineEventInit } from "@teaspill/schema";

const TS = "2026-07-17T00:00:00.000Z";
const RUN = "run-conf-1";

export const spawnedInit: TimelineEventInit = {
  type: "entity_spawned",
  ts: TS,
  payload: { entityType: "conformance-echo", parentId: null },
};

export const runStartedInit: TimelineEventInit = {
  type: "run_started",
  ts: TS,
  payload: { runId: RUN, wake: { source: "message" }, harness: "native" },
};

export function userMessageInit(text: string): TimelineEventInit {
  return {
    type: "message",
    ts: TS,
    payload: { id: "m-user", runId: RUN, role: "user", content: [{ type: "text", text }] },
  };
}

export function assistantMessageInit(text: string): TimelineEventInit {
  return {
    type: "message",
    ts: TS,
    payload: { id: "m-assistant", runId: RUN, role: "assistant", content: [{ type: "text", text }] },
  };
}

export const runFinishedInit: TimelineEventInit = {
  type: "run_finished",
  ts: TS,
  payload: { runId: RUN, outcome: "success", usage: { inputTokens: 10, outputTokens: 5 } },
};
