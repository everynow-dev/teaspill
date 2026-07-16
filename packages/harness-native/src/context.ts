/**
 * Context-assembly contract (T3.1): canonical events → provider messages.
 *
 * STATUS: PROPOSED alongside the schema/interface — freezes at gate G3.
 *
 * Each harness converts the entity's `canonicalContext` (ordered canonical
 * events) into its provider's message shape — pi-ai `AgentMessage[]` for the
 * native harness (T3.2), CASDK session entries for the cold-rebuild path
 * (T7.1). The conversion is harness-specific; the SELECTION of which events
 * participate, and how summarization folds them, is shared and lives here so
 * both harnesses (and the CASDK cold rebuild) reconstruct the same
 * conversation from the same timeline.
 *
 * ## Assembly rules (normative)
 *
 * Given the selected events (see `selectContextEvents`):
 * - `message(user)`            → a user message.
 * - `message(assistant)`       → an assistant message; consecutive assistant
 *                                content (incl. following tool calls) may
 *                                merge into one provider message.
 * - `message(system_note)`     → a user message wrapped in a clear marker
 *                                (e.g. `[system note] …`). NEVER the
 *                                API-level system prompt — the system prompt
 *                                is harness config, not timeline history.
 * - `tool_call`                → a tool-use block on the assistant side.
 * - `tool_result`              → a tool-result block on the user side.
 * - `summarization`            → a user-side note carrying `summary`,
 *                                standing in for everything it folded.
 * - `opaque(origin=<own>)`     → a harness may replay its OWN opaque records
 *                                natively (CASDK cold rebuild); every other
 *                                harness renders them as nothing.
 * - everything else (`entity_spawned`, `run_started`, `run_finished`,
 *   `state_snapshot`, `control`, `error`, `child_spawned`, `child_finished`,
 *   `archived`, `reasoning`, foreign `opaque`) → NOT context-bearing.
 *   Anything the model should know about them is expressed as an explicit
 *   `message(system_note)` by the platform (e.g. "child X finished: …").
 *   `reasoning` in particular is display-only history and MUST NOT be
 *   replayed into provider context (CASDK thinking signatures are
 *   unforgeable; cross-provider replay is meaningless).
 * - a dangling `tool_call` with no matching `tool_result` (crash mid-tool)
 *   must be repaired by the harness before the provider sees it (synthesize
 *   an error tool-result, as electric's `repairDanglingToolCalls` does).
 */

import type { TimelineEvent } from "@teaspill/schema";

/**
 * The function shape harnesses implement: selected canonical events → the
 * provider's message array. MUST be pure (no I/O, no clock) — the native
 * harness calls it between journaled steps where determinism is required.
 */
export type ContextAssembler<ProviderMessage> = (
  events: readonly TimelineEvent[],
) => ProviderMessage[];

/** Event types that participate in context assembly. */
export const CONTEXT_BEARING_TYPES = [
  "message",
  "tool_call",
  "tool_result",
  "summarization",
] as const;

export type ContextBearingType = (typeof CONTEXT_BEARING_TYPES)[number];

export function isContextBearing(
  event: TimelineEvent,
): event is TimelineEvent & { type: ContextBearingType } {
  return (CONTEXT_BEARING_TYPES as readonly string[]).includes(event.type);
}

/**
 * Apply the summarization fold and the context-bearing filter — the shared
 * first half of every assembler.
 *
 * Rules:
 * - Only context-bearing events (plus caller-opted opaque origins) survive.
 * - The LATEST `summarization` event (highest seq) wins: context-bearing
 *   events with `seq <= replacesThroughSeq` are dropped and the winning
 *   summarization stands in for them (assemblers render its `summary` as a
 *   user-side note). All other summarization events are dropped — each
 *   later summary was produced from context that already folded the earlier
 *   ones. (Normative: a summarization's `replacesThroughSeq` must be >= any
 *   earlier summarization's — folds only grow.)
 * - Events must be in ascending seq order (they come from agent K/V state
 *   which maintains it); this function trusts but verifies.
 */
export function selectContextEvents(
  events: readonly TimelineEvent[],
  opts: {
    /** Opaque origins the calling harness can replay natively (e.g. `casdk`). */
    includeOpaqueOrigins?: readonly string[];
  } = {},
): TimelineEvent[] {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.seq <= events[i - 1]!.seq) {
      throw new Error(`selectContextEvents: events not in ascending seq order at index ${i}`);
    }
  }

  const opaqueOrigins = new Set(opts.includeOpaqueOrigins ?? []);

  // The winning (latest-by-seq) summarization, if any. Events are ascending,
  // so the last one seen wins.
  let winner: (TimelineEvent & { type: "summarization" }) | undefined;
  for (const ev of events) {
    if (ev.type === "summarization") winner = ev;
  }
  const boundary = winner?.payload.replacesThroughSeq ?? -1;

  const out: TimelineEvent[] = [];
  for (const ev of events) {
    // Non-winning summarizations are always folded away.
    if (ev.type === "summarization" && ev !== winner) continue;
    const bearing =
      isContextBearing(ev) || (ev.type === "opaque" && opaqueOrigins.has(ev.payload.origin));
    if (!bearing) continue;
    // Superseded by the winning summarization (which itself survives —
    // its seq is > replacesThroughSeq by schema invariant).
    if (ev.seq <= boundary) continue;
    out.push(ev);
  }
  return out;
}
