/**
 * Cold-rebuild projection (T7.1, D5 layer 3 recovery path) — canonical
 * timeline → session JSONL.
 *
 * Pipeline (mirrors electric's `buildSessionInput`, adapted to canonical):
 *   1. `selectContextEvents` (shared, harness-native) — context-bearing
 *      filter + summarization fold (`summarization` WINS on cold rebuild —
 *      the SDK's own compaction never rewrites canonical truth), replaying
 *      our own `opaque(origin='casdk')` records natively;
 *   2. event-level REPAIR — dangling `tool_call` without a `tool_result`
 *      (crash mid-tool) gets a synthesized error result; orphan
 *      `tool_result`s are dropped;
 *   3. SPLIT — the trailing run of user-side events (the wake message, steer
 *      arrivals, system notes) is NOT projected into the transcript: it is
 *      returned as `feedEvents` and fed to the live run as streaming input
 *      (a session must not END on the input we're about to send, or the SDK
 *      would have nothing to respond to);
 *   4. translation-table mapping (`eventToLineBodies`) + uuid/parentUuid
 *      chaining + monotonic timestamps + the bidirectional ID map.
 *
 * Determinism: uuids and the timestamp base are injected, so golden fixtures
 * are byte-stable.
 */

import type { TimelineEvent } from "@teaspill/schema";
import { selectContextEvents } from "@teaspill/harness-native";
import { canonicalEventKey, createIdMapBuilder, type IdMap } from "./id-map.js";
import type { SessionLine, UnchainedLine } from "./session-lines.js";
import { INTERRUPTED_TOOL_RESULT_TEXT, chainLines } from "./session-lines.js";
import { eventToLineBodies } from "./translation.js";

export interface ProjectionResult {
  /** The synthesized transcript (may be empty — fresh session, no resume). */
  lines: SessionLine[];
  /** Trailing user-side events to feed as the run's streaming input. */
  feedEvents: TimelineEvent[];
  /** canonical ↔ line-uuid map (regenerable session metadata). */
  idMap: IdMap;
  /** toolUseIds that received a synthesized error result (observability). */
  repairedToolUseIds: string[];
}

export interface ProjectionOptions {
  newUuid: () => string;
  /** Timestamp base for the projected lines (monotonic +1ms per line). */
  baseTimeMs: number;
}

/** Is this event feedable as live user input (rather than transcript)? */
export function isUserFeedable(event: TimelineEvent): boolean {
  return event.type === "message" && (event.payload.role === "user" || event.payload.role === "system_note");
}

/**
 * Split selected context events into transcript prefix + trailing user feed.
 * Only the TRAILING run of user-feedable events moves to the feed.
 */
export function splitTrailingUserEvents(events: readonly TimelineEvent[]): {
  transcript: TimelineEvent[];
  feed: TimelineEvent[];
} {
  let cut = events.length;
  while (cut > 0 && isUserFeedable(events[cut - 1]!)) cut -= 1;
  return { transcript: events.slice(0, cut), feed: events.slice(cut) };
}

/**
 * Event-level repair (docs/casdk-mapping.md §3, last row): pair every
 * tool_call, anchor every tool_result — BEFORE translation, so the projected
 * transcript is always API-valid.
 */
export function repairContextEvents(events: readonly TimelineEvent[]): {
  events: TimelineEvent[];
  repairedToolUseIds: string[];
} {
  const resulted = new Set<string>();
  const called = new Set<string>();
  for (const ev of events) {
    if (ev.type === "tool_call") called.add(ev.payload.toolUseId);
    if (ev.type === "tool_result") resulted.add(ev.payload.toolUseId);
  }

  const out: TimelineEvent[] = [];
  const repaired: string[] = [];
  const seenCalls = new Set<string>();
  for (const ev of events) {
    if (ev.type === "tool_result") {
      // Orphan (no preceding call in the selected slice) → drop.
      if (!seenCalls.has(ev.payload.toolUseId)) continue;
      out.push(ev);
      continue;
    }
    out.push(ev);
    if (ev.type === "tool_call") {
      seenCalls.add(ev.payload.toolUseId);
      if (!resulted.has(ev.payload.toolUseId)) {
        repaired.push(ev.payload.toolUseId);
        out.push({
          ...ev,
          type: "tool_result",
          payload: {
            runId: ev.payload.runId,
            toolUseId: ev.payload.toolUseId,
            name: ev.payload.name,
            content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
            isError: true,
          },
        } as TimelineEvent);
      }
    }
  }
  return { events: out, repairedToolUseIds: repaired };
}

/**
 * Project the canonical context into a resumable session transcript.
 * `events` is the entity's `canonicalContext` in ascending seq order.
 */
export function projectCanonicalToSession(
  events: readonly TimelineEvent[],
  opts: ProjectionOptions,
): ProjectionResult {
  const selected = selectContextEvents(events, { includeOpaqueOrigins: ["casdk"] });
  const { transcript, feed } = splitTrailingUserEvents(selected);
  const { events: repairedEvents, repairedToolUseIds } = repairContextEvents(transcript);

  const idMapBuilder = createIdMapBuilder();
  const bodies: UnchainedLine[] = [];
  const bodyKeys: string[] = [];
  for (const ev of repairedEvents) {
    for (const body of eventToLineBodies(ev)) {
      bodies.push(body);
      bodyKeys.push(canonicalEventKey(ev));
    }
  }

  // SESSION_FORMAT: the first content line must be a user line. A transcript
  // that would open on an assistant line gets an explicit rebuild marker.
  if (bodies[0]?.type === "assistant") {
    bodies.unshift({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[session rebuilt from canonical timeline]" }],
      },
    });
    bodyKeys.unshift("synthetic:rebuild-marker");
  }

  const lines = chainLines(bodies, { newUuid: opts.newUuid, baseTimeMs: opts.baseTimeMs });
  lines.forEach((line, i) => {
    if (line.uuid !== undefined) idMapBuilder.add(bodyKeys[i]!, line.uuid);
  });

  return { lines, feedEvents: feed, idMap: idMapBuilder.build(), repairedToolUseIds };
}
