/**
 * THE translation table (T7.1, R3) — every CASDK ↔ canonical mapping rule, in
 * ONE file, keyed by pinned SDK version.
 *
 * This file implements `docs/casdk-mapping.md` (frozen alongside the schema,
 * DECISIONS A5):
 * - §2 capture direction — SDK stream record → canonical event(s)/delta(s)
 *   (the per-record CLASSIFICATION lives here; the run-scoped state machine
 *   that orders/merges them is `capture.ts`);
 * - §3 cold-rebuild direction — canonical event → session line(s);
 * - the inverse (session line → canonical), used by the golden
 *   identity-modulo-ids fixtures and by session-file recovery;
 * - §4.4 the enumerated known-drop list (exhaustive PER SDK VERSION — any
 *   stream record neither mapped nor on this list becomes `opaque`, never
 *   silently dropped).
 *
 * ## Per-version branching (R3 discipline)
 *
 * `TRANSLATIONS` maps an exact SDK version to its table. A version bump means:
 * add a branch, re-run the golden fixtures, extend/trim the drop list. Unknown
 * versions THROW at harness construction (`getTranslation`) — format drift is
 * a visible failure, never silent corruption. Since projection is only the
 * cold/recovery path (D5 layer 3), drift can never disrupt committed truth.
 */

import type { ContentBlock, JsonValue, TimelineEvent, TimelineEventInit } from "@teaspill/schema";
import { SUMMARY_MARKER, SYSTEM_NOTE_MARKER } from "@teaspill/harness-native";
import type {
  SessionContentBlock,
  SessionImageBlock,
  SessionLine,
  SessionTextBlock,
  SessionToolResultBlock,
  SessionToolUseBlock,
  UnchainedLine,
} from "./session-lines.js";
import { contentBlocksOf, isContentLine, toJsonValue } from "./session-lines.js";
import type { SdkStreamRecord } from "./sdk-client.js";
import { PINNED_SDK_VERSION } from "./sdk-client.js";

// ---------------------------------------------------------------------------
// MCP tool-name qualification (single source of truth — T7.2 consumes)
// ---------------------------------------------------------------------------

export const TEASPILL_MCP_SERVER = "teaspill";

/** Canonical bare tool name → the MCP-qualified name the SDK sees. */
export function toMcpName(name: string): string {
  return `mcp__${TEASPILL_MCP_SERVER}__${name}`;
}

/** MCP-qualified → bare canonical name; non-teaspill names pass through. */
export function fromMcpName(qualified: string): string {
  const prefix = `mcp__${TEASPILL_MCP_SERVER}__`;
  return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified;
}

// ---------------------------------------------------------------------------
// Content-block conversion (canonical ContentBlock ↔ Anthropic session block)
// ---------------------------------------------------------------------------

export function contentToSessionBlocks(blocks: readonly ContentBlock[]): SessionContentBlock[] {
  return blocks.map((b) =>
    b.type === "text"
      ? ({ type: "text", text: b.text } satisfies SessionTextBlock)
      : ({
          type: "image",
          source: { type: "base64", media_type: b.mimeType, data: b.data },
        } satisfies SessionImageBlock),
  );
}

/**
 * Session/API blocks → canonical ContentBlocks. Unknown block kinds render as
 * text placeholders (they cannot ride canonical content — A5 froze
 * ContentBlock to text+image; richer payloads belong in `detail`/`opaque`).
 */
export function sessionBlocksToContent(blocks: readonly SessionContentBlock[] | string): ContentBlock[] {
  if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      out.push({ type: "text", text: (b as SessionTextBlock).text });
    } else if (b.type === "image") {
      const src = (b as SessionImageBlock).source;
      out.push({ type: "image", mimeType: src.media_type, data: src.data });
    } else {
      out.push({ type: "text", text: `[unsupported content block: ${b.type}]` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-version table
// ---------------------------------------------------------------------------

export interface TranslationTable {
  sdkVersion: string;
  /**
   * §4.4 — enumerated operational chatter, deliberately dropped at capture.
   * Exhaustive for the pinned version: anything NOT matched here and not
   * handled by capture.ts's explicit switch becomes `opaque`.
   */
  isKnownDrop(record: SdkStreamRecord): boolean;
}

/** `system`-subtype chatter enumerated from the 0.3.211 `SDKMessage` union. */
const SYSTEM_DROP_SUBTYPES_0_3_211 = new Set([
  "status",
  "api_retry",
  "control_request_progress",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "local_command_output",
  "hook_started",
  "hook_progress",
  "hook_response",
  "plugin_install",
  "task_notification",
  "task_started",
  "task_updated",
  "task_progress",
  "background_tasks_changed",
  "thinking_tokens",
  "session_state_changed",
  "worker_shutting_down",
  "commands_changed",
  "notification",
  "files_persisted",
  "memory_recall",
  "elicitation_complete",
  "permission_denied",
  "informational",
]);

/** Top-level-type chatter enumerated from the 0.3.211 `SDKMessage` union. */
const TOP_DROP_TYPES_0_3_211 = new Set([
  "tool_progress",
  "auth_status",
  "tool_use_summary",
  "prompt_suggestion",
  "rate_limit_event",
  "conversation_reset",
]);

const TABLE_0_3_211: TranslationTable = {
  sdkVersion: "0.3.211",
  isKnownDrop(record) {
    if (record.type === "system" && typeof record.subtype === "string") {
      // `mirror_error` is NOT dropped — capture.ts taints the session on it.
      return SYSTEM_DROP_SUBTYPES_0_3_211.has(record.subtype);
    }
    return TOP_DROP_TYPES_0_3_211.has(record.type);
  },
};

const TRANSLATIONS: Record<string, TranslationTable> = {
  "0.3.211": TABLE_0_3_211,
};

export function supportedSdkVersions(): string[] {
  return Object.keys(TRANSLATIONS);
}

/** Throws loudly on an unpinned/unknown SDK version (R3: drift is visible). */
export function getTranslation(sdkVersion: string = PINNED_SDK_VERSION): TranslationTable {
  const table = TRANSLATIONS[sdkVersion];
  if (!table) {
    throw new Error(
      `harness-casdk has no translation table for SDK version ${JSON.stringify(sdkVersion)} ` +
        `(supported: ${supportedSdkVersions().join(", ")}). An SDK bump requires adding a ` +
        `per-version branch in translation.ts and re-validating the golden fixtures (R3).`,
    );
  }
  return table;
}

// ---------------------------------------------------------------------------
// §3 — canonical event → session line bodies (cold-rebuild direction)
// ---------------------------------------------------------------------------

/**
 * Project ONE canonical event to zero-or-more session line bodies.
 * PRECONDITION: the caller has already applied `selectContextEvents`
 * (summarization fold + context-bearing filter, `includeOpaqueOrigins:
 * ['casdk']`) — only `message`/`tool_call`/`tool_result`/`summarization`/
 * `opaque(origin='casdk')` reach this function; everything else maps to no
 * line by that selection (docs/casdk-mapping.md §3, last row).
 *
 * `reasoning` never reaches here either (not context-bearing) — thinking is
 * STRIPPED on cold rebuild by design (§4.5: signatures are unforgeable).
 */
export function eventToLineBodies(event: TimelineEvent): UnchainedLine[] {
  switch (event.type) {
    case "message": {
      const { role, content } = event.payload;
      if (role === "user") {
        return [{ type: "user", message: { role: "user", content: contentToSessionBlocks(content) } }];
      }
      if (role === "system_note") {
        // Rendered as a MARKED user message — never the API system prompt.
        return [
          {
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "text", text: `${SYSTEM_NOTE_MARKER} ${textOf(content)}` },
                ...contentToSessionBlocks(content.filter((b) => b.type !== "text")),
              ],
            },
          },
        ];
      }
      // assistant: ONE content block per assistant line (native CLI shape —
      // SESSION_FORMAT: synthesized multi-block lines are untested).
      return contentToSessionBlocks(content).map((block) => ({
        type: "assistant",
        message: { role: "assistant", content: [block] },
      }));
    }
    case "tool_call":
      return [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: event.payload.toolUseId,
                name: toMcpName(event.payload.name),
                input: event.payload.input,
              } satisfies SessionToolUseBlock,
            ],
          },
        },
      ];
    case "tool_result": {
      const block: SessionToolResultBlock = {
        type: "tool_result",
        tool_use_id: event.payload.toolUseId,
        content: contentToSessionBlocks(event.payload.content) as Array<
          SessionTextBlock | SessionImageBlock
        >,
        // `is_error` only when true, matching the observed on-disk format.
        ...(event.payload.isError && { is_error: true }),
      };
      return [{ type: "user", message: { role: "user", content: [block] } }];
    }
    case "summarization":
      // ONE user line standing in for everything <= replacesThroughSeq
      // (selectContextEvents already removed the folded events).
      return [
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: `${SUMMARY_MARKER} ${event.payload.summary}` }],
          },
        },
      ];
    case "opaque": {
      // Only our own session-line opaques replay verbatim; stream-record
      // opaques (kind 'stream/*') have no session-line form.
      if (event.payload.origin === "casdk" && event.payload.kind.startsWith("session/")) {
        const data = event.payload.data;
        if (data !== null && typeof data === "object" && !Array.isArray(data)) {
          // Strip stored chain identity — the projector re-chains.
          const { uuid: _u, parentUuid: _p, timestamp: _t, ...rest } = data as Record<string, JsonValue>;
          return [rest as UnchainedLine];
        }
      }
      return [];
    }
    default:
      // Defensive: selection should never let these through.
      return [];
  }
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Inverse — session line → canonical event inits (golden round-trip +
// session-file recovery capture)
// ---------------------------------------------------------------------------

/**
 * Translate one session line back to canonical event inits. Used by the
 * golden fixtures (cold-projection → resume(no-op) → capture → canonical must
 * be identity-modulo-ids) and available as a recovery path for reading a
 * session file directly.
 *
 * Marker inversion: `[system note] …` user lines → `message(system_note)`,
 * `[conversation summary] …` user lines → `summarization` (with
 * `replacesThroughSeq: 0` — a seq-valued field, regenerated by the caller /
 * ignored by identity-modulo-ids). Meta lines → `opaque(session/<type>)`.
 */
export function sessionLineToEvents(
  line: SessionLine,
  opts: { ts?: string; idFor?: (kind: "message" | "reasoning") => string } = {},
): TimelineEventInit[] {
  const ts = opts.ts ?? line.timestamp ?? new Date(0).toISOString();
  const idFor = opts.idFor ?? ((kind) => `${kind}-${line.uuid ?? "unknown"}`);

  if (!isContentLine(line)) {
    // Chain identity is regenerated on every projection (and stripped again
    // on replay by eventToLineBodies) — keep it out of the opaque payload so
    // the round trip is stable.
    const { uuid: _u, parentUuid: _p, timestamp: _t, ...data } = line;
    return [
      {
        type: "opaque",
        ts,
        payload: { origin: "casdk", kind: `session/${line.type}`, data: toJsonValue(data) },
      },
    ];
  }

  const events: TimelineEventInit[] = [];
  const role = line.message.role;
  const blocks = contentBlocksOf(line);

  // Group plain text/image content into one message; tool blocks split out.
  let msgContent: ContentBlock[] = [];
  const flushMessage = (): void => {
    if (msgContent.length === 0) return;
    const first = msgContent[0];
    let msgRole: "user" | "assistant" | "system_note" = role;
    let content = msgContent;
    if (role === "user" && first?.type === "text") {
      if (first.text.startsWith(`${SYSTEM_NOTE_MARKER} `)) {
        msgRole = "system_note";
        content = [{ type: "text", text: first.text.slice(SYSTEM_NOTE_MARKER.length + 1) }, ...msgContent.slice(1)];
      } else if (first.text.startsWith(`${SUMMARY_MARKER} `)) {
        events.push({
          type: "summarization",
          ts,
          payload: {
            summary: first.text.slice(SUMMARY_MARKER.length + 1),
            replacesThroughSeq: 0, // seq-valued; regenerated by the consumer
          },
        });
        msgContent = [];
        return;
      }
    }
    events.push({
      type: "message",
      ts,
      payload: { id: idFor("message"), role: msgRole, content },
    });
    msgContent = [];
  };

  for (const b of blocks) {
    switch (b.type) {
      case "text":
        msgContent.push({ type: "text", text: (b as SessionTextBlock).text });
        break;
      case "image": {
        const src = (b as SessionImageBlock).source;
        msgContent.push({ type: "image", mimeType: src.media_type, data: src.data });
        break;
      }
      case "tool_use": {
        flushMessage();
        const tu = b as SessionToolUseBlock;
        events.push({
          type: "tool_call",
          ts,
          payload: {
            runId: "recovered",
            toolUseId: tu.id,
            name: fromMcpName(tu.name),
            input: toJsonValue(tu.input),
          },
        });
        break;
      }
      case "tool_result": {
        flushMessage();
        const tr = b as SessionToolResultBlock;
        events.push({
          type: "tool_result",
          ts,
          payload: {
            runId: "recovered",
            toolUseId: tr.tool_use_id,
            content: sessionBlocksToContent(tr.content ?? []),
            isError: tr.is_error === true,
          },
        });
        break;
      }
      case "thinking":
        // Thinking in a session file is the SDK's own (real signatures). It
        // is display-only in canonical; recovery does not resurrect it as
        // `reasoning` because capture already recorded it live — dropping
        // here avoids duplicate reasoning on recovery. (Deliberate asymmetry,
        // mapping §4.5.)
        break;
      default:
        // Unknown block kind inside a content line: preserve losslessly.
        events.push({
          type: "opaque",
          ts,
          payload: {
            origin: "casdk",
            kind: `session/block/${b.type}`,
            data: toJsonValue(b),
          },
        });
        break;
    }
  }
  flushMessage();
  return events;
}
