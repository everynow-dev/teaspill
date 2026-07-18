/**
 * Canonical `TimelineEventInit` builders for the OFFLINE chaos runners. These
 * are staged through the REAL `DurableStreamsProjectionOutbox`, which allocates
 * seqs (0001:A1) and finalizes them — so the fixtures carry NO seq, exactly like
 * harness output. (Conformance keeps its own run-fixtures internal, so the
 * chaos package carries its own to stay self-contained.)
 */

import type { TimelineEventInit } from "@teaspill/schema";

const TS = "2026-07-17T00:00:00.000Z";
const RUN = "run-chaos-1";

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

/**
 * The `error` event a workspace exec TIMEOUT projects (executor killed
 * mid-exec, host-unresponsive backstop → tool error). `source: "tool"` — the
 * failing workspace tool call; a machine-readable `code` per the schema.
 */
export function execTimeoutErrorInit(message: string): TimelineEventInit {
  return {
    type: "error",
    ts: TS,
    payload: {
      runId: RUN,
      code: "workspace_exec_timeout",
      message,
      source: "tool",
      detail: { timeoutKind: "host-unresponsive" },
    },
  };
}

/** A failed `run_finished` (outcome `error`) — the run ends after the tool error. */
export const runFinishedErrorInit: TimelineEventInit = {
  type: "run_finished",
  ts: TS,
  payload: { runId: RUN, outcome: "error", usage: { inputTokens: 10, outputTokens: 0 } },
};
