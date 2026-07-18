/**
 * pi step-client seam (0001:T3.2) — the LLM-call abstraction the step-durable
 * harness journals.
 *
 * The native harness (./pi-harness.ts) never talks to a provider directly:
 * every LLM call goes through a `PiStepClient` whose `step()` performs ONE
 * model turn and resolves with a bounded, JSON-safe `PiStepTurn`. The harness
 * wraps each `step()` in its own journaled `ctx.run` — the turn IS the journal
 * entry — so the client must return only journal-safe data (plain JSON, no
 * class instances, bulk text bounded by the model's max output tokens).
 *
 * Two implementations:
 * - `createPiAiStepClient` (./pi-provider.ts) — the real multi-provider
 *   client over `@mariozechner/pi-ai` (`streamSimple`/`completeSimple`).
 * - test fakes (pi-harness.test.ts) — scripted turn/tool/error sequences,
 *   which is what makes the step-durability contract testable offline.
 *
 * ## Error contract (retryable vs terminal — PLAN 0001:T3.2 "Anticipate")
 *
 * `step()` rejects with a `PiProviderError` for provider failures. The
 * harness's journaled closure then:
 * - `retryable: true`  → RETHROWS out of `ctx.run`, so Restate retries the
 *   step (and only the step — completed steps replay from the journal and
 *   are never re-billed).
 * - `retryable: false` → the closure RETURNS a `provider_error` step result
 *   (journaled — the failed call is never re-attempted), and the harness
 *   converts it into canonical `error(source:'provider')` +
 *   `run_finished(outcome:'error')`.
 *
 * An abort (the run's `AbortSignal`) surfaces as a rejection whose
 * name/message matches `isAbortError`; the harness maps it to the
 * `interrupted` outcome, never to an error event.
 */

import type { JsonValue } from "@teaspill/schema";

// ===========================================================================
// Neutral history messages (assembler output → step input)
// ===========================================================================

/** Content blocks on the user side (canonical `ContentBlock` shape, pass-through). */
export type PiUserBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

/**
 * Assistant-side history blocks. `thinking` appears ONLY for turns produced
 * within the CURRENT run (replayed from the step journal, signature intact,
 * so providers that require thinking blocks echoed during a tool-use loop —
 * Anthropic extended thinking — stay valid). Canonical `reasoning` events
 * from PREVIOUS wakes are never assembled back into context (0001:T3.1 rule:
 * display-only history).
 */
export type PiAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string; redacted?: boolean }
  | { type: "toolCall"; toolUseId: string; name: string; input: JsonValue };

/**
 * Provider-neutral conversation message. Deliberately timestamp-free — the
 * assembler that produces these must be pure (0001:T3.1 `ContextAssembler`
 * contract: no clock); the concrete client stamps whatever timestamps its
 * wire format wants at call time (inside the journaled step).
 */
export type PiHistoryMessage =
  | { role: "user"; content: PiUserBlock[] }
  | { role: "assistant"; content: PiAssistantBlock[] }
  | {
      role: "toolResult";
      toolUseId: string;
      toolName: string;
      content: PiUserBlock[];
      isError: boolean;
    };

// ===========================================================================
// Step request / result
// ===========================================================================

/** A tool as presented to the provider: JSON Schema derived from the zod schema. */
export interface PiToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (from `z.toJSONSchema`). */
  inputSchema: JsonValue;
}

/**
 * Streaming fragments forwarded DURING a step. Fire-and-forget material for
 * the harness's `emitDelta` mapping — never authoritative (the finalized
 * turn wins; deltas are not re-emitted when a completed step replays from
 * the journal, which is exactly the delta-channel contract).
 */
export type PiStepDelta =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_input"; toolUseId?: string; text: string };

export interface PiStepRequest {
  systemPrompt?: string;
  messages: readonly PiHistoryMessage[];
  tools: readonly PiToolSpec[];
  /** Merged run abort (interrupt verb + attempt-completed, 0001:A4). */
  signal: AbortSignal;
  /** Absent when the caller wants a buffered (non-streamed) call. */
  onDelta?: (delta: PiStepDelta) => void;
}

/** Journal-safe per-step usage (pi-ai `Usage` field names, §6 mapping applies later). */
export interface PiTurnUsage {
  /** New uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
}

export type PiTurnBlock =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      text: string;
      /** Provider thinking signature (kept for same-run replay, never canonical). */
      signature?: string;
      /** Opaque redacted-thinking payload (canonical `reasoning.encrypted`). */
      redacted?: boolean;
    }
  | { type: "toolCall"; toolUseId: string; name: string; input: JsonValue };

/** One completed model turn. Plain JSON — this object is what gets journaled. */
export interface PiStepTurn {
  content: PiTurnBlock[];
  usage: PiTurnUsage;
  /** Non-error stop reasons only — errors/aborts REJECT (see module header). */
  stopReason: "stop" | "length" | "toolUse";
}

/**
 * One LLM call per `step()` — the unit the harness journals. Implementations
 * MUST honor `signal` and the error contract in the module header.
 */
export interface PiStepClient {
  /** Provider tag for canonical `error.detail` / `run_started.detail`. */
  readonly provider: string;
  /** Model id for `run_started.payload.model`. */
  readonly model: string;
  /** Context window in tokens, when known — seeds the default summarization budget. */
  readonly contextWindow?: number | undefined;
  /**
   * True when this client BUFFERS (no `onDelta` fragments; the turn arrives
   * whole). The journal granularity is identical either way — buffering only
   * silences the ephemeral delta channel (PLAN 0001:T3.2: buffer per provider
   * rather than weaken journal granularity).
   */
  readonly buffered: boolean;
  step(req: PiStepRequest): Promise<PiStepTurn>;
}

// ===========================================================================
// Provider error classification (retryable vs terminal)
// ===========================================================================

export type PiProviderErrorCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_INVALID_REQUEST"
  | "PROVIDER_ERROR";

/**
 * Retryable ⇒ the journaled step closure rethrows and Restate re-runs THE
 * STEP (transient infrastructure/provider pressure). Terminal ⇒ journaled as
 * a `provider_error` result and converted to canonical events (retrying
 * cannot help; hammering the provider would just re-bill failures).
 * `PROVIDER_ERROR` (unclassified) is deliberately TERMINAL — the safe default
 * for unknown failure shapes; reclassify as evidence accumulates.
 */
export const RETRYABLE_PROVIDER_CODES: readonly PiProviderErrorCode[] = [
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNREACHABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
];

export class PiProviderError extends Error {
  override readonly name = "PiProviderError";
  readonly code: PiProviderErrorCode;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly model?: string;

  constructor(opts: {
    code: PiProviderErrorCode;
    message: string;
    provider?: string;
    model?: string;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = opts.code;
    this.retryable = RETRYABLE_PROVIDER_CODES.includes(opts.code);
    if (opts.provider !== undefined) this.provider = opts.provider;
    if (opts.model !== undefined) this.model = opts.model;
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return [error.name, error.message, cause === undefined ? "" : stringifyError(cause)]
      .filter(Boolean)
      .join(" ");
  }
  return String(error);
}

/**
 * Heuristic classifier over provider/network error text (lifted from the
 * electric `model-provider-error.ts` pattern, extended with the terminal
 * invalid-request bucket). Abort errors are NOT classified here — check
 * `isAbortError` first.
 */
export function classifyProviderError(error: unknown): PiProviderErrorCode {
  const text = stringifyError(error).toLowerCase();

  if (/\btimeouterror\b/.test(text) || text.includes("timeout") || text.includes("timed out")) {
    return "PROVIDER_TIMEOUT";
  }
  if (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("invalid api key") ||
    text.includes("authentication") ||
    text.includes("unauthorized") ||
    text.includes("permission")
  ) {
    return "PROVIDER_AUTH_FAILED";
  }
  if (text.includes("429") || text.includes("rate limit")) {
    return "PROVIDER_RATE_LIMITED";
  }
  if (
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("overloaded") ||
    text.includes("unavailable")
  ) {
    return "PROVIDER_UNAVAILABLE";
  }
  if (
    text.includes("enotfound") ||
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("eai_again") ||
    text.includes("fetch failed") ||
    text.includes("failed to fetch") ||
    text.includes("network")
  ) {
    return "PROVIDER_UNREACHABLE";
  }
  if (
    text.includes("400") ||
    text.includes("422") ||
    text.includes("invalid request") ||
    text.includes("invalid_request") ||
    text.includes("context length") ||
    text.includes("prompt is too long")
  ) {
    return "PROVIDER_INVALID_REQUEST";
  }
  return "PROVIDER_ERROR";
}

/** Coerce any provider failure into a `PiProviderError` (idempotent). */
export function toPiProviderError(
  error: unknown,
  opts: { provider?: string; model?: string } = {},
): PiProviderError {
  if (error instanceof PiProviderError) return error;
  const code = classifyProviderError(error);
  const detail = error instanceof Error ? error.message : String(error);
  return new PiProviderError({
    code,
    message: `${code}: ${detail}`,
    ...(opts.provider !== undefined && { provider: opts.provider }),
    ...(opts.model !== undefined && { model: opts.model }),
    cause: error,
  });
}

/**
 * True for abort-shaped rejections (`AbortError` DOMException, fetch aborts,
 * pi-ai `stopReason: "aborted"` conversions). Checked BEFORE classification:
 * an abort maps to outcome `interrupted`, never to a provider error.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    const msg = error.message.toLowerCase();
    return msg.includes("aborted") || msg.includes("abort");
  }
  return false;
}
