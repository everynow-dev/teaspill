/**
 * @teaspill/frontend-sdk — framework-agnostic core (0001:T5.2).
 *
 * - `createAgentTimeline` — timeline stream (+ sibling `/deltas`) →
 *   materialized collections via the pure reducer (0001:A6 seq-idempotent,
 *   0001:A7 fast-join, finalized-event-always-wins, 0001:D3 drift detection).
 * - `createAgentCatalog` — entity rows over Electric shapes through the
 *   gateway `/shapes/*` proxy.
 * - `createActionsClient` — spawn/send/control through the gateway `/api/*`.
 *
 * React bindings are a separate optional entry: `@teaspill/frontend-sdk/react`
 * (`useAgentTimeline`, `useAgentCatalog`) — the core never imports React.
 *
 * Canonical event/delta types come from `@teaspill/schema` (FROZEN v1, 0001:A5);
 * the most useful ones are re-exported for UI convenience.
 */

export * from "./reducer.js";
export * from "./timeline.js";
export * from "./catalog.js";
export * from "./actions.js";
export * from "./auth.js";

// Re-export the schema vocabulary UIs need (frozen v1, DECISIONS 0001:A5) plus the
// fast-join planning helpers (0001:A7) so most frontends need no direct schema dep.
export {
  checkSeqContiguity,
  checkTimelineInvariants,
  fastJoinFromSeq,
  parseTimelineEvent,
  safeParseTimelineEvent,
  parseDeltaRecord,
  safeParseDeltaRecord,
  selectFastJoinSnapshot,
  type ContentBlock,
  type ControlVerb,
  type DeltaKind,
  type DeltaRecord,
  type EventType,
  type FastJoinCandidate,
  type HarnessKind,
  type JsonValue,
  type MessageRole,
  type RunUsage,
  type TimelineEvent,
} from "@teaspill/schema";
