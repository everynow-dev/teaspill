/**
 * Golden-fixture support (0001:T7.1, 0001:R3): "cold-projection → resume(no-op) →
 * capture → canonical must be IDENTITY-MODULO-IDS".
 *
 * `normalizeForGolden` maps events (full or init) onto a shape with every
 * regenerable identifier removed, so two pipelines can be compared for
 * semantic identity:
 * - envelope: `v`/`entityId`/`seq`/`ts` dropped;
 * - payload: minted ids (`message.id`, `reasoning.id`), `runId`s, and
 *   seq-valued fields (`replacesThroughSeq`) dropped;
 * - `toolUseId` is KEPT — it is the durable cross-domain identifier (rides
 *   verbatim through session lines both directions), so identity is stronger
 *   than pure shape equality where it matters most (the exactly-once key);
 * - the ENUMERATED non-round-tripped enrichments are dropped:
 *   `tool_result.detail` + `tool_result.name` (tool-layer enrichments — the
 *   session's MCP-shaped tool_result carries only content, mapping §4.6) and
 *   `message.from` (platform routing metadata, not conversation content).
 */

import type { TimelineEvent, TimelineEventInit } from "@teaspill/schema";

export type GoldenEvent = { type: string; payload: Record<string, unknown> };

export function normalizeForGolden(
  events: readonly (TimelineEvent | TimelineEventInit)[],
): GoldenEvent[] {
  return events.map((ev) => {
    const payload: Record<string, unknown> = { ...(ev.payload as Record<string, unknown>) };
    delete payload["runId"];
    switch (ev.type) {
      case "message":
        delete payload["id"];
        delete payload["from"];
        break;
      case "reasoning":
        delete payload["id"];
        break;
      case "tool_result":
        delete payload["detail"];
        delete payload["name"];
        break;
      case "summarization":
        delete payload["replacesThroughSeq"];
        delete payload["detail"];
        break;
      default:
        break;
    }
    return { type: ev.type, payload };
  });
}
