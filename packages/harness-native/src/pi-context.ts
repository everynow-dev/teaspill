/**
 * pi context assembly (T3.2) — canonical events → provider-neutral messages.
 *
 * Implements the normative T3.1 assembly rules (./context.ts module header)
 * for the native harness: `selectContextEvents` does the shared selection +
 * summarization fold; this module renders the survivors as
 * `PiHistoryMessage[]` with the merge semantics lifted from electric's
 * `toAgentHistory` (pi-adapter.ts): consecutive assistant content — including
 * following tool calls — merges into one assistant message, text-to-text
 * boundaries concatenate.
 *
 * EVERYTHING here is PURE (no I/O, no clock, no randomness) — the harness
 * calls it between journaled steps where determinism is required (A4).
 */

import type { ContentBlock, TimelineEvent } from "@teaspill/schema";
import { selectContextEvents } from "./context.js";
import type { PiAssistantBlock, PiHistoryMessage, PiUserBlock } from "./pi-client.js";

/** Marker prefixes (context.ts: system notes/summaries render as MARKED user messages). */
export const SYSTEM_NOTE_MARKER = "[system note]";
export const SUMMARY_MARKER = "[conversation summary]";

/** Text synthesized for a dangling tool_call repaired at assembly time. */
export const DANGLING_TOOL_RESULT_TEXT =
  "Tool call did not complete (the run was interrupted or crashed mid-tool). No result is available.";

const toUserBlocks = (content: readonly ContentBlock[]): PiUserBlock[] =>
  content.map((b) =>
    b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image", mimeType: b.mimeType, data: b.data },
  );

/** Render marked user text (system notes, summaries): marker + text blocks, images pass through. */
function markedUserMessage(marker: string, content: readonly ContentBlock[]): PiHistoryMessage {
  const blocks: PiUserBlock[] = [];
  let markerAttached = false;
  for (const b of content) {
    if (b.type === "text") {
      blocks.push({
        type: "text",
        text: markerAttached ? b.text : `${marker} ${b.text}`,
      });
      markerAttached = true;
    } else {
      blocks.push({ type: "image", mimeType: b.mimeType, data: b.data });
    }
  }
  if (!markerAttached) blocks.unshift({ type: "text", text: marker });
  return { role: "user", content: blocks };
}

/**
 * Merge assistant blocks into the trailing assistant message when there is
 * one (electric `toAgentHistory` semantics: text-text boundary concatenates).
 */
function pushAssistantBlocks(out: PiHistoryMessage[], blocks: readonly PiAssistantBlock[]): void {
  if (blocks.length === 0) return;
  const last = out[out.length - 1];
  if (last?.role === "assistant") {
    const prevLast = last.content[last.content.length - 1];
    const [first, ...rest] = blocks;
    if (prevLast?.type === "text" && first!.type === "text") {
      last.content[last.content.length - 1] = {
        type: "text",
        text: `${prevLast.text}${first!.text}`,
      };
      last.content.push(...rest);
    } else {
      last.content.push(...blocks);
    }
    return;
  }
  out.push({ role: "assistant", content: [...blocks] });
}

/**
 * Repair dangling tool calls (T3.1 rule: a `tool_call` with no matching
 * `tool_result` must never reach the provider): synthesize an error
 * toolResult immediately after the assistant message that carries the call,
 * before any later message. Pure; returns a new array when repairs happen.
 */
export function repairDanglingToolCalls(messages: readonly PiHistoryMessage[]): PiHistoryMessage[] {
  const resolved = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult") resolved.add(m.toolUseId);
  }
  const out: PiHistoryMessage[] = [];
  let pending: Array<{ toolUseId: string; name: string }> = [];
  const flushPending = (): void => {
    for (const p of pending) {
      out.push({
        role: "toolResult",
        toolUseId: p.toolUseId,
        toolName: p.name,
        content: [{ type: "text", text: DANGLING_TOOL_RESULT_TEXT }],
        isError: true,
      });
    }
    pending = [];
  };
  for (const m of messages) {
    if (m.role === "toolResult") {
      out.push(m);
      pending = pending.filter((p) => p.toolUseId !== m.toolUseId);
      continue;
    }
    // A non-toolResult message: any still-unresolved calls dangle — repair
    // them before it so results stay adjacent to their calls.
    flushPending();
    out.push(m);
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "toolCall" && !resolved.has(b.toolUseId)) {
          pending.push({ toolUseId: b.toolUseId, name: b.name });
        }
      }
    }
  }
  flushPending();
  return out;
}

/**
 * The native harness's `ContextAssembler`: canonical events (in seq order)
 * → provider-neutral messages. Applies `selectContextEvents` (shared fold +
 * filter), then the §7 rendering rules:
 *
 * - `message(user)`        → user message
 * - `message(assistant)`   → assistant message (consecutive content merges)
 * - `message(system_note)` → marked user message (never the API system prompt)
 * - `tool_call`            → toolCall block on the assistant side
 * - `tool_result`          → toolResult message
 * - `summarization` winner → marked user message carrying `summary`
 * - opaque(pi origins)     → nothing (pi has no session-native records to replay)
 * - dangling tool calls    → repaired with synthesized error results
 */
export function assemblePiContext(
  events: readonly TimelineEvent[],
  opts: { includeOpaqueOrigins?: readonly string[] } = {},
): PiHistoryMessage[] {
  const selected = selectContextEvents(events, opts);
  const out: PiHistoryMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const ev of selected) {
    switch (ev.type) {
      case "message": {
        if (ev.payload.role === "assistant") {
          // Text-only is deliberate and lossless-in-practice: assistant-side
          // content has NO image representation at the provider boundary
          // (pi-ai assistant blocks are text|thinking|toolCall), and this
          // harness never produces assistant `message` events with image
          // blocks. USER and TOOL_RESULT content preserves images (below).
          pushAssistantBlocks(
            out,
            ev.payload.content
              .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
              .map((b): PiAssistantBlock => ({ type: "text", text: b.text })),
          );
        } else if (ev.payload.role === "system_note") {
          out.push(markedUserMessage(SYSTEM_NOTE_MARKER, ev.payload.content));
        } else {
          out.push({ role: "user", content: toUserBlocks(ev.payload.content) });
        }
        break;
      }
      case "tool_call": {
        toolNames.set(ev.payload.toolUseId, ev.payload.name);
        pushAssistantBlocks(out, [
          {
            type: "toolCall",
            toolUseId: ev.payload.toolUseId,
            name: ev.payload.name,
            input: ev.payload.input,
          },
        ]);
        break;
      }
      case "tool_result": {
        out.push({
          role: "toolResult",
          toolUseId: ev.payload.toolUseId,
          toolName: ev.payload.name ?? toolNames.get(ev.payload.toolUseId) ?? "",
          content: toUserBlocks(ev.payload.content),
          isError: ev.payload.isError,
        });
        break;
      }
      case "summarization": {
        out.push(
          markedUserMessage(SUMMARY_MARKER, [{ type: "text", text: ev.payload.summary }]),
        );
        break;
      }
      default:
        // opaque with an included origin: pi has nothing native to replay —
        // rendered as nothing (context.ts: "every other harness renders them
        // as nothing"). Non-context-bearing types never reach here.
        break;
    }
  }

  return repairDanglingToolCalls(out);
}

/**
 * The summarization fold boundary for THIS run: the highest seq among
 * context-bearing canonical events (post-fold — what the model actually has
 * in context from the timeline). `null` when the canonical context carries
 * nothing foldable (then there is nothing to summarize away). Mid-run events
 * have no seq yet (A1: seq is allocated at the outbox), so a mid-run
 * summarization can only fold the canonical prefix — see pi-harness.ts.
 */
export function latestContextBearingSeq(events: readonly TimelineEvent[]): number | null {
  const selected = selectContextEvents(events);
  const last = selected[selected.length - 1];
  return last === undefined ? null : last.seq;
}

/**
 * Cheap deterministic token estimate (~4 chars/token over the serialized
 * content). Used ONLY to bridge accounting gaps (before the first real usage
 * anchor, and for the trailing messages appended since it) — real per-step
 * usage from the provider re-anchors after every step (pi-adapter pattern).
 * Pure — safe between journaled steps.
 */
export function estimateMessageTokens(messages: readonly PiHistoryMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}
