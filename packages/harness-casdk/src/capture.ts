/**
 * Capture (T7.1, D5 layer 3 — Truth): the SDK stream → canonical events +
 * deltas, per `docs/casdk-mapping.md` §2. The per-record classification comes
 * from translation.ts; this module is the run-scoped state machine that
 * orders, merges, and finalizes.
 *
 * Shape notes:
 * - One canonical `message`/`reasoning` event per assistant STEP (API turn):
 *   the SDK emits one assistant record per content block (all sharing the API
 *   `message.id`); blocks are grouped by that id and flushed when a
 *   non-assistant record arrives (tool results, result, next turn), keeping
 *   canonical ordering `reasoning → message → tool_call*` per step —
 *   matching the Anthropic content order (thinking, text, tool_use).
 * - Delta refs are deterministic per step: `msg-<runId>-s<k>`,
 *   `rsn-<runId>-s<k>` — the SAME ids the finalized events use, so the T5.2
 *   "finalized event wins" dedup rule works.
 * - Usage: per-step usage accumulates from assistant records (deduped by API
 *   message id); the terminal `result` usage is NEVER routed per-step
 *   (double-count hazard, digest §1.5); `total_cost_usd` IS taken from the
 *   result (cost has no per-step source).
 * - `signature_delta` is dropped (unforgeable thinking signatures, §4.5).
 * - Unknown records → `opaque(origin:'casdk', kind:'stream/<type>[/<sub>]')`;
 *   known chatter (table) is dropped; subagent traffic (parent_tool_use_id)
 *   → opaque, defensively.
 * - `system`/`mirror_error` TAINTS the session (a mirror batch was dropped —
 *   the store's transcript may have a hole): the harness forces a cold
 *   rebuild next wake instead of trusting a holey mirror.
 */

import type { ContentBlock, JsonValue, RunUsage, TimelineEventInit } from "@teaspill/schema";
import type { EmitDelta } from "@teaspill/harness-native";
import { toJsonValue } from "./session-lines.js";
import type { SdkStreamRecord, SdkUsage } from "./sdk-client.js";
import {
  isAssistant,
  isCompactBoundary,
  isInit,
  isMirrorError,
  isPartial,
  isResult,
  isUser,
} from "./sdk-client.js";
import type { TranslationTable } from "./translation.js";
import { fromMcpName, sessionBlocksToContent } from "./translation.js";
import type { ToolResultDetailSource } from "./tool-seam.js";

export interface CaptureOptions {
  entityId: string;
  runId: string;
  attempt?: number | undefined;
  table: TranslationTable;
  emitDelta: EmitDelta;
  detail: ToolResultDetailSource;
  /** The session id we asked to resume (warm) or pre-assigned (cold w/ lines). */
  expectedSessionId?: string | undefined;
  now?: () => number;
  /** replacesThroughSeq for a mid-run SDK compaction (canonical head at run start). */
  foldBoundarySeq?: number | undefined;
}

export interface CaptureResult {
  events: TimelineEventInit[];
  usage: RunUsage;
  /** Cache-inclusive prompt size of the last step (stateDelta.contextTokens). */
  contextTokens: number | undefined;
  /** The live session id from `system`/`init` (authoritative). */
  sessionId: string | undefined;
  /** Set when a resume silently started a fresh session (hard divergence). */
  resumeMismatch: boolean;
  /** Set when a mirror batch was dropped — force cold rebuild next wake. */
  sessionTainted: boolean;
  /** Terminal result summary (feeds run_finished). */
  outcome: "success" | "error" | "none";
  errorEvents: number;
  initDetail: JsonValue | undefined;
}

interface PendingStep {
  apiMessageId: string | undefined;
  texts: string[];
  thinking: string[];
  encrypted: string | undefined;
  toolCalls: Array<{ toolUseId: string; name: string; input: JsonValue }>;
  usage: SdkUsage | undefined;
}

export class CaptureState {
  private readonly o: CaptureOptions;
  private readonly events: TimelineEventInit[] = [];
  private step: PendingStep | null = null;
  private stepIndex = 0;
  private currentToolBlockId: string | undefined;
  private readonly deltaIdx = new Map<string, number>();
  private readonly totals = { input: 0, cacheRead: 0, output: 0, steps: 0 };
  private lastContextTokens: number | undefined;
  private costUsd: number | undefined;
  private sessionId: string | undefined;
  private initDetail: JsonValue | undefined;
  private resumeMismatch = false;
  private sessionTainted = false;
  private outcome: "success" | "error" | "none" = "none";
  private errorEvents = 0;
  private pendingCompact: JsonValue | undefined;
  private compactSummary: string | undefined;

  constructor(options: CaptureOptions) {
    this.o = options;
  }

  private ts(): string {
    return new Date((this.o.now ?? Date.now)()).toISOString();
  }

  private msgId(): string {
    return `msg-${this.o.runId}-s${this.stepIndex}`;
  }
  private rsnId(): string {
    return `rsn-${this.o.runId}-s${this.stepIndex}`;
  }

  private emitDelta(kind: "text" | "reasoning" | "tool_input", ref: string, text: string): void {
    const idx = this.deltaIdx.get(ref) ?? 0;
    this.deltaIdx.set(ref, idx + 1);
    this.o.emitDelta({
      kind,
      runId: this.o.runId,
      ref,
      idx,
      ts: this.ts(),
      text,
      ...(this.o.attempt !== undefined && { attempt: this.o.attempt }),
    });
  }

  /**
   * Inject an externally-authored event (steer messages) at the CURRENT
   * stream position: any pending assistant step flushes first, so canonical
   * ordering matches what the model actually saw.
   */
  pushExternalEvent(event: TimelineEventInit): void {
    this.flushStep();
    this.events.push(event);
  }

  /** Called by the harness's PostCompact hook observer. */
  onCompactSummary(summary: string): void {
    if (summary.trim().length > 0) this.compactSummary = summary;
    this.maybeEmitSummarization();
  }

  private maybeEmitSummarization(): void {
    if (this.compactSummary === undefined || this.pendingCompact === undefined) return;
    const boundary = this.o.foldBoundarySeq;
    if (boundary === undefined || boundary < 0) {
      // Nothing canonical to fold — record the compaction as opaque instead.
      this.events.push({
        type: "opaque",
        ts: this.ts(),
        payload: {
          origin: "casdk",
          kind: "stream/system/compact_boundary",
          data: { metadata: this.pendingCompact, summary: this.compactSummary },
        },
      });
    } else {
      this.events.push({
        type: "summarization",
        ts: this.ts(),
        payload: {
          runId: this.o.runId,
          summary: this.compactSummary,
          replacesThroughSeq: boundary,
          detail: this.pendingCompact,
        },
      });
    }
    this.pendingCompact = undefined;
    this.compactSummary = undefined;
  }

  private flushStep(): void {
    const s = this.step;
    if (!s) return;
    this.step = null;
    const ts = this.ts();
    if (s.thinking.length > 0 || s.encrypted !== undefined) {
      this.events.push({
        type: "reasoning",
        ts,
        payload: {
          id: this.rsnId(),
          runId: this.o.runId,
          text: s.thinking.join("\n\n"),
          ...(s.encrypted !== undefined && { encrypted: s.encrypted }),
        },
      });
    }
    if (s.texts.length > 0) {
      this.events.push({
        type: "message",
        ts,
        payload: {
          id: this.msgId(),
          runId: this.o.runId,
          role: "assistant",
          content: [{ type: "text", text: s.texts.join("") }],
        },
      });
    }
    for (const tc of s.toolCalls) {
      this.events.push({
        type: "tool_call",
        ts,
        payload: { runId: this.o.runId, toolUseId: tc.toolUseId, name: tc.name, input: tc.input },
      });
    }
    if (s.usage) {
      const u = s.usage;
      this.totals.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      this.totals.cacheRead += u.cache_read_input_tokens ?? 0;
      this.totals.output += u.output_tokens ?? 0;
      this.lastContextTokens =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
    this.totals.steps += 1;
    this.stepIndex += 1;
  }

  private ensureStep(apiMessageId: string | undefined): PendingStep {
    if (this.step && this.step.apiMessageId !== undefined && apiMessageId !== undefined && this.step.apiMessageId !== apiMessageId) {
      // A new API turn started without an intervening non-assistant record.
      this.flushStep();
    }
    if (!this.step) {
      this.step = {
        apiMessageId,
        texts: [],
        thinking: [],
        encrypted: undefined,
        toolCalls: [],
        usage: undefined,
      };
    } else if (this.step.apiMessageId === undefined) {
      this.step.apiMessageId = apiMessageId;
    }
    return this.step;
  }

  /** Feed one stream record. */
  onRecord(record: SdkStreamRecord): void {
    // --- init -------------------------------------------------------------
    if (isInit(record)) {
      this.sessionId = record.session_id;
      this.initDetail = toJsonValue({
        sessionId: record.session_id,
        model: record.model,
        permissionMode: record.permissionMode,
        toolCount: Array.isArray(record.tools) ? record.tools.length : undefined,
      });
      if (this.o.expectedSessionId !== undefined && record.session_id !== this.o.expectedSessionId) {
        // Silent fresh-session-on-resume (digest §3) — hard divergence.
        this.resumeMismatch = true;
      }
      return;
    }

    // --- partial/stream events → deltas ------------------------------------
    if (isPartial(record)) {
      const ev = record.event;
      if (ev.type === "content_block_start") {
        const cb = (ev as { content_block?: { type?: string; id?: string } }).content_block;
        this.currentToolBlockId = cb?.type === "tool_use" && typeof cb.id === "string" ? cb.id : undefined;
      } else if (ev.type === "content_block_delta") {
        const delta = (ev as { delta?: { type?: string; text?: string; thinking?: string; partial_json?: string } }).delta;
        if (!delta) return;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          this.emitDelta("text", this.msgId(), delta.text);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          this.emitDelta("reasoning", this.rsnId(), delta.thinking);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          // ref = toolUseId (deltas.ts contract), learned from content_block_start.
          const ref = this.currentToolBlockId ?? `tool-${this.o.runId}-s${this.stepIndex}`;
          this.emitDelta("tool_input", ref, delta.partial_json);
        }
        // signature_delta: deliberately dropped (§4.5).
      }
      // message_start/message_delta/message_stop: usage is taken from the
      // full assistant records (dedup by API message id) — no action here.
      return;
    }

    // --- assistant records --------------------------------------------------
    if (isAssistant(record)) {
      if (record.parent_tool_use_id !== null && record.parent_tool_use_id !== undefined) {
        // Subagent traffic must not occur (no built-in subagents) — opaque.
        this.events.push({
          type: "opaque",
          ts: this.ts(),
          payload: { origin: "casdk", kind: "stream/assistant/subagent", data: toJsonValue(record) },
        });
        return;
      }
      const apiId = record.message.id;
      const step = this.ensureStep(apiId);
      // Usage arrives on every block-record of the turn — keep the LAST.
      if (record.message.usage) step.usage = record.message.usage;
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      for (const raw of content) {
        const b = raw as { type?: string; [k: string]: unknown };
        switch (b.type) {
          case "text":
            step.texts.push(String(b["text"] ?? ""));
            break;
          case "thinking":
            step.thinking.push(String(b["thinking"] ?? b["text"] ?? ""));
            break;
          case "redacted_thinking":
            step.encrypted = String(b["data"] ?? "");
            break;
          case "tool_use":
            // Buffered on the step; flushStep emits reasoning → message →
            // tool_call(s), preserving the Anthropic content order. Tool
            // RESULTS always arrive on a later user record, which flushes
            // the step first — so tool_call precedes its tool_result.
            step.toolCalls.push({
              toolUseId: String(b["id"] ?? ""),
              name: fromMcpName(String(b["name"] ?? "")),
              input: toJsonValue(b["input"] ?? {}),
            });
            break;
          default:
            this.events.push({
              type: "opaque",
              ts: this.ts(),
              payload: {
                origin: "casdk",
                kind: `stream/assistant/block/${String(b.type ?? "unknown")}`,
                data: toJsonValue(raw),
              },
            });
            break;
        }
      }
      return;
    }

    // --- user records (tool results; prompt replays) ------------------------
    if (isUser(record)) {
      this.flushStep();
      const content = record.message.content;
      const blocks = Array.isArray(content) ? content : [];
      let sawToolResult = false;
      for (const raw of blocks) {
        const b = raw as { type?: string; [k: string]: unknown };
        if (b.type !== "tool_result") continue;
        sawToolResult = true;
        const toolUseId = String(b["tool_use_id"] ?? "");
        const detail =
          this.o.detail.take(toolUseId) ??
          (record.tool_use_result !== undefined ? toJsonValue(record.tool_use_result) : undefined);
        const rawContent = b["content"];
        const contentBlocks: ContentBlock[] =
          typeof rawContent === "string"
            ? rawContent.length > 0
              ? [{ type: "text", text: rawContent }]
              : []
            : Array.isArray(rawContent)
              ? sessionBlocksToContent(rawContent as never)
              : [];
        this.events.push({
          type: "tool_result",
          ts: this.ts(),
          payload: {
            runId: this.o.runId,
            toolUseId,
            content: contentBlocks,
            ...(detail !== undefined && { detail }),
            isError: b["is_error"] === true,
          },
        });
      }
      // Plain user text = the SDK replaying our own prompt — the wake/steer
      // `message` event already exists on the timeline. NOT captured (§2).
      void sawToolResult;
      return;
    }

    // --- compaction ---------------------------------------------------------
    if (isCompactBoundary(record)) {
      this.flushStep();
      this.pendingCompact = toJsonValue(record.compact_metadata);
      this.maybeEmitSummarization();
      return;
    }

    // --- mirror errors → taint ---------------------------------------------
    if (isMirrorError(record)) {
      this.sessionTainted = true;
      this.errorEvents += 1;
      this.events.push({
        type: "error",
        ts: this.ts(),
        payload: {
          runId: this.o.runId,
          code: "casdk_mirror_error",
          message: "SDK session-mirror append batch dropped; durable session tainted (next wake cold-rebuilds)",
          source: "harness",
          detail: toJsonValue(record),
        },
      });
      return;
    }

    // --- terminal result ----------------------------------------------------
    if (isResult(record)) {
      this.flushStep();
      if (typeof record.total_cost_usd === "number") this.costUsd = record.total_cost_usd;
      if (record.subtype === "success") {
        this.outcome = "success";
      } else {
        this.outcome = "error";
        this.errorEvents += 1;
        this.events.push({
          type: "error",
          ts: this.ts(),
          payload: {
            runId: this.o.runId,
            code: record.subtype,
            message:
              (Array.isArray(record.errors) && record.errors.length > 0
                ? record.errors.join("; ")
                : undefined) ?? `CASDK run ended with ${record.subtype}`,
            source: "harness",
          },
        });
      }
      // Cumulative result usage is NEVER accumulated per-step (double-count
      // hazard) — only cost is read from it.
      return;
    }

    // --- known chatter → dropped; unknown → opaque --------------------------
    if (this.o.table.isKnownDrop(record)) return;
    this.flushStep();
    this.events.push({
      type: "opaque",
      ts: this.ts(),
      payload: {
        origin: "casdk",
        kind: `stream/${record.type}${typeof record.subtype === "string" ? `/${record.subtype}` : ""}`,
        data: toJsonValue(record),
      },
    });
  }

  finish(): CaptureResult {
    this.flushStep();
    // A boundary that never received its PostCompact summary still must not
    // vanish silently.
    if (this.pendingCompact !== undefined) {
      this.events.push({
        type: "opaque",
        ts: this.ts(),
        payload: {
          origin: "casdk",
          kind: "stream/system/compact_boundary",
          data: { metadata: this.pendingCompact, summary: null },
        },
      });
      this.pendingCompact = undefined;
    }
    const usage: RunUsage = {
      inputTokens: this.totals.input,
      outputTokens: this.totals.output,
      ...(this.totals.cacheRead > 0 && { cacheReadTokens: this.totals.cacheRead }),
      ...(this.lastContextTokens !== undefined && { contextTokens: this.lastContextTokens }),
      steps: this.totals.steps,
      ...(this.costUsd !== undefined && { costUsd: this.costUsd }),
      ...(this.o.attempt !== undefined && { attempt: this.o.attempt }),
    };
    return {
      events: this.events,
      usage,
      contextTokens: this.lastContextTokens,
      sessionId: this.sessionId,
      resumeMismatch: this.resumeMismatch,
      sessionTainted: this.sessionTainted,
      outcome: this.outcome,
      errorEvents: this.errorEvents,
      initDetail: this.initDetail,
    };
  }
}
