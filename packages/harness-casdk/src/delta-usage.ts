/**
 * Delta + usage mapping (0001:T7.4) — the FORMALIZED, independently-testable core
 * of two mappings `docs/casdk-mapping.md` specifies but 0001:T7.1/0001:T7.2 wired inline
 * inside `capture.ts`:
 *
 * 1. **Delta mapping (§2).** CASDK `stream_event` partials → the ephemeral
 *    delta channel: `text_delta`→`text`, `thinking_delta`→`reasoning`,
 *    `input_json_delta`→`tool_input`, `signature_delta`→dropped (§4.5,
 *    unforgeable signatures). `content_block_start` for a `tool_use` block
 *    carries the toolUseId that later `input_json_delta`s ref. `classifyPartial`
 *    is the pure classifier; `capture.ts` owns the run-scoped ref bookkeeping
 *    (`msg-<runId>-s<k>` / `rsn-<runId>-s<k>` / toolUseId) and idx counters so
 *    a delta's `ref`/`idx`/`attempt` line up with the finalized event the 0001:T5.2
 *    reducer dedups against ("finalized event always wins").
 *
 * 2. **Usage mapping (§6).** Per-step Anthropic/CASDK `SdkUsage` → canonical
 *    `RunUsage`, field-for-field:
 *      - `inputTokens`   = Σ (`input_tokens` + `cache_creation_input_tokens`)
 *      - `cacheReadTokens` = Σ `cache_read_input_tokens` (omitted when 0)
 *      - `outputTokens`  = Σ `output_tokens`
 *      - `contextTokens` = LAST step's cache-inclusive prompt size
 *                          (`input + cache_creation + cache_read`)
 *      - `steps`         = number of assistant steps
 *      - `costUsd`       = terminal `result.total_cost_usd` (no per-step source)
 *      - `attempt`       = the Restate invocation attempt (retry reconciliation)
 *    The cumulative terminal `result.usage` is NEVER accumulated per step
 *    (double-count hazard, §1.5) — only `total_cost_usd` is read from it.
 *
 * ## Attempt reconciliation (the load-bearing bit)
 *
 * `attempt` is the Restate invocation attempt id (`HarnessRunInput.attempt`,
 * from the harness ctx / 0001:A4 surface). It is stamped on EVERY usage figure —
 * the authoritative `run_finished.payload.usage.attempt` (via `finalizeUsage`)
 * AND each live `usage` DeltaRecord (via `buildUsageDelta`) AND each
 * text/reasoning/tool_input delta. When Restate retries a failed run the same
 * run re-emits usage under a higher attempt; the 0001:T5.2 reducer keeps only the
 * highest attempt per ref/run and drops lower-attempt stragglers, so a
 * failed-then-retried run never double-counts.
 */

import type { DeltaInit, RunUsage } from "@teaspill/schema";
import type { SdkUsage } from "./sdk-client.js";

// ===========================================================================
// Usage (§6)
// ===========================================================================

/** Running usage totals across a run's assistant steps. */
export interface UsageTotals {
  /** Σ (input_tokens + cache_creation_input_tokens) — UNCACHED input. */
  input: number;
  /** Σ cache_read_input_tokens. */
  cacheRead: number;
  /** Σ output_tokens. */
  output: number;
  /** Number of assistant steps folded (usage-bearing OR not). */
  steps: number;
  /** LAST step's cache-inclusive prompt size, or undefined if no step had usage. */
  contextTokens: number | undefined;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, cacheRead: 0, output: 0, steps: 0, contextTokens: undefined };
}

/**
 * Fold ONE assistant step into the totals (§6 formula). ALWAYS counts a step
 * (a step with no usage record still advances `steps`, matching a turn that
 * produced content but the SDK reported no usage on). Returns a NEW object.
 */
export function accumulateStepUsage(totals: UsageTotals, usage: SdkUsage | undefined): UsageTotals {
  const next: UsageTotals = { ...totals, steps: totals.steps + 1 };
  if (usage) {
    const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    next.input += input;
    next.cacheRead += cacheRead;
    next.output += usage.output_tokens ?? 0;
    // contextTokens tracks the LAST step's cache-inclusive prompt size.
    next.contextTokens = input + cacheRead;
  }
  return next;
}

/** Materialize the canonical `RunUsage` from totals + terminal cost + attempt (§6). */
export function finalizeUsage(
  totals: UsageTotals,
  opts: { costUsd?: number | undefined; attempt?: number | undefined } = {},
): RunUsage {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    ...(totals.cacheRead > 0 && { cacheReadTokens: totals.cacheRead }),
    ...(totals.contextTokens !== undefined && { contextTokens: totals.contextTokens }),
    steps: totals.steps,
    ...(opts.costUsd !== undefined && { costUsd: opts.costUsd }),
    ...(opts.attempt !== undefined && { attempt: opts.attempt }),
  };
}

/**
 * The cumulative-so-far snapshot carried by a live `usage` DeltaRecord (a
 * best-effort gauge). Cost is omitted (only known at the terminal result) and
 * `attempt` rides the delta envelope, not this partial.
 */
export function usageSnapshot(totals: UsageTotals): Partial<RunUsage> {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    ...(totals.cacheRead > 0 && { cacheReadTokens: totals.cacheRead }),
    ...(totals.contextTokens !== undefined && { contextTokens: totals.contextTokens }),
    steps: totals.steps,
  };
}

/**
 * Stateful wrapper over the pure folds above — the shape `capture.ts` drives.
 * One per run; `addStep` at each assistant-step flush, `finalize` at run end.
 */
export class UsageAccumulator {
  private totals: UsageTotals = emptyUsageTotals();

  addStep(usage: SdkUsage | undefined): void {
    this.totals = accumulateStepUsage(this.totals, usage);
  }

  get steps(): number {
    return this.totals.steps;
  }

  /** LAST step's cache-inclusive prompt size (stateDelta.contextTokens). */
  get contextTokens(): number | undefined {
    return this.totals.contextTokens;
  }

  /** Cumulative snapshot for a live `usage` delta. */
  snapshot(): Partial<RunUsage> {
    return usageSnapshot(this.totals);
  }

  finalize(opts: { costUsd?: number | undefined; attempt?: number | undefined } = {}): RunUsage {
    return finalizeUsage(this.totals, opts);
  }
}

/**
 * Build a live `usage` DeltaRecord init (`ref` = runId per deltas.ts). The
 * platform sink stamps `v`/`entityId`; the harness supplies the rest. `attempt`
 * is the Restate invocation attempt — the reducer keeps the highest attempt per
 * run and drops the rest (retry reconciliation, 0001:T7.4).
 */
export function buildUsageDelta(args: {
  runId: string;
  idx: number;
  ts: string;
  usage: Partial<RunUsage>;
  attempt?: number | undefined;
}): DeltaInit {
  return {
    kind: "usage",
    runId: args.runId,
    ref: args.runId,
    idx: args.idx,
    ts: args.ts,
    usage: args.usage,
    ...(args.attempt !== undefined && { attempt: args.attempt }),
  };
}

// ===========================================================================
// Delta mapping (§2) — partial stream_event classification
// ===========================================================================

/**
 * The classification of one CASDK `stream_event.event`. `capture.ts` turns
 * these into DeltaRecords by attaching the run-scoped `ref` and `idx`:
 * - `tool_block_start` announces the toolUseId a subsequent `tool_input` refs;
 * - `text`/`reasoning`/`tool_input` are the three emitted delta kinds;
 * - `signature_drop` is deliberately dropped (§4.5);
 * - `ignore` covers message_start/message_delta/message_stop (usage is taken
 *   authoritatively from the full assistant records) and anything else.
 */
export type PartialClassification =
  | { op: "tool_block_start"; toolUseId: string | undefined }
  | { op: "text"; text: string }
  | { op: "reasoning"; text: string }
  | { op: "tool_input"; text: string }
  | { op: "signature_drop" }
  | { op: "ignore" };

interface PartialEvent {
  type?: string;
  content_block?: { type?: string; id?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; signature?: string };
  [k: string]: unknown;
}

/** Pure classifier for a `stream_event.event` (docs/casdk-mapping.md §2). */
export function classifyPartial(event: PartialEvent | undefined): PartialClassification {
  if (!event || typeof event.type !== "string") return { op: "ignore" };
  if (event.type === "content_block_start") {
    const cb = event.content_block;
    const toolUseId = cb?.type === "tool_use" && typeof cb.id === "string" ? cb.id : undefined;
    return { op: "tool_block_start", toolUseId };
  }
  if (event.type === "content_block_delta") {
    const delta = event.delta;
    if (!delta) return { op: "ignore" };
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return { op: "text", text: delta.text };
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      return { op: "reasoning", text: delta.thinking };
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      return { op: "tool_input", text: delta.partial_json };
    }
    if (delta.type === "signature_delta") {
      return { op: "signature_drop" };
    }
  }
  return { op: "ignore" };
}
