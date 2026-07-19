/**
 * PiHarness (0001:T3.2) — the fully step-durable owned loop (0001:D5's gold standard).
 *
 * ## Step-durability shape
 *
 * The harness OWNS the agent loop and journals it at step granularity
 * through an injected `HarnessCtx` (a minimal `ctx.run` seam over the entity
 * handler's Restate `ObjectContext`):
 *
 * - **Every LLM call is its own `ctx.run`** (`pi:llm-<step>`,
 *   `pi:summarize-<n>`). The journaled result is the bounded assistant turn
 *   (text/tool-calls/usage — capped by the model's max output tokens); bulk
 *   streaming goes out-of-band through `emitDelta` and is NOT in the journal.
 *   A completed step replays from the journal on retry — the provider is
 *   never re-billed (PLAN 0001:T3.2), and its deltas are simply not re-emitted
 *   (finalized event wins, the 0001:T5.2 dedup rule).
 * - **Every tool call is its own journaled step** (`pi:tool-<step>-<i>`)
 *   executing through the injected `ToolContext`, whose clients route through
 *   Restate ingress with the exactly-once idempotency key
 *   `(entityUrl, runId, toolUseId)` (0001:T3.1 invariant 1) — so even a retried
 *   tool step re-issues the SAME key and the effect happens once.
 * - **Canonical events commit through the outbox at each step boundary** via
 *   `HarnessRunInput.commitEvents` (the 0001:T3.1 seam; the entity handler
 *   allocates seq, 0001:A1). Without `commitEvents` the events are returned at the
 *   end (invariant 3 — never both).
 * - **The steerbox is drained before each LLM step** (`pi:steer-<step>`,
 *   journaled — the drain is I/O). Drained messages commit as canonical
 *   user `message` events and join the provider context ahead of the step.
 *
 * ## Determinism (0001:A4)
 *
 * Between journaled steps the loop is deterministic: no naked clock/random
 * reads (every timestamp comes from inside a `ctx.run` closure or a journaled
 * step result; ids derive from `runId` + step counters; context assembly is
 * pure). Provider errors are classified retryable-vs-terminal (pi-client.ts):
 * retryable failures RETHROW out of the step so Restate retries that step;
 * terminal failures are JOURNALED as the step's result and converted to
 * `error(source:'provider')` + `run_finished(outcome:'error')`.
 *
 * ## Steering choice (documented per task)
 *
 * A steer does NOT abort an in-flight generation. Steers inject strictly at
 * step boundaries: the current LLM step completes, its result is journaled,
 * and the steer becomes input to the next step. Aborting mid-generation would
 * discard a step Restate would then re-run on retry — re-billing the provider
 * — which violates the never-re-billed invariant for no latency win worth
 * that cost. (The `interrupt` verb still aborts immediately via `signal`.)
 *
 * ## Context budget / summarization
 *
 * Before each LLM step the harness compares the cache-inclusive context size
 * (real usage anchor from the last step + a pure estimate of messages
 * appended since — the pi-adapter anchoring pattern) against the budget.
 * Over budget → a summary is produced via its OWN `ctx.run` LLM call and a
 * canonical `summarization` event commits with `replacesThroughSeq` set to the
 * last context-bearing seq the model currently holds. That boundary starts at
 * `latestContextBearingSeq(canonicalContext)` and ADVANCES as the step-boundary
 * `commitEvents` seam returns the seqs the outbox allocated to mid-run events
 * (0002:T3.2): the finalized return lets the harness fold MORE THAN ONCE per run,
 * each fold covering everything up to its boundary — including the previous
 * fold's own `summarization` event — so a run that exceeds budget twice folds
 * twice with a correct `replacesThroughSeq` each time. A fold collapses the
 * entire provider context to the summary note (everything held has committed
 * seqs <= the boundary). At the next wake the standard `selectContextEvents`
 * fold applies (latest summarization wins). The A4 journal budget is honored:
 * the harness keeps only the last context-bearing seq from each commit, never
 * the event bodies. (Pre-0002, mid-run events had no seq until the outbox
 * allocated one, 0001:A1, so a mid-run summarization could fold only the
 * canonical prefix and was limited to one fold per run.)
 *
 * ## Run boundaries
 *
 * Per the 0001:T3.2 task text this harness authors `run_started`/`run_finished`
 * itself and commits them through the outbox seam. The current 0001:T2.1
 * `agent.ts#runWake` ALSO authors run boundaries around the stub harness —
 * when the handler wiring adopts the step-durable path it must either pass
 * `emitRunBoundaries: false` here or stop authoring its own pair (never
 * both). Flagged for the main session.
 *
 * ## Construction
 *
 * A `PiHarness` is constructed PER WAKE: `HarnessCtx` wraps the live
 * invocation's `ObjectContext`, so the handler builds
 * `createPiHarness({ ctx, client, toolContext, ... })` inside the wake and
 * calls `.run(input)` (NOT wrapped in an outer `ctx.run` — the harness
 * journals its own steps).
 */

import { z } from "zod";
import { SpanStatusCode } from "@opentelemetry/api";
import type {
  ContentBlock,
  DeltaInit,
  JsonValue,
  RunUsage,
  TimelineEventInit,
  WakeSource,
} from "@teaspill/schema";
import type {
  AnyToolDefinition,
  Harness,
  HarnessRunInput,
  HarnessRunResult,
  ToolContext,
  ToolExecutionResult,
} from "./interface.js";
import { toolIdempotencyKey } from "./interface.js";
import { isContextBearing } from "./context.js";
import { isTerminalControl, readPlatformControlSignal } from "./tools.js";
import type { PlatformControlSignal } from "./tools.js";
import {
  isAbortError,
  toPiProviderError,
  type PiHistoryMessage,
  type PiStepClient,
  type PiStepDelta,
  type PiStepTurn,
  type PiToolSpec,
  type PiTurnUsage,
} from "./pi-client.js";
import {
  SUMMARY_MARKER,
  assemblePiContext,
  estimateMessageTokens,
  latestContextBearingSeq,
} from "./pi-context.js";
import { getTracer } from "./otel.js";

// ===========================================================================
// Seams
// ===========================================================================

/**
 * The journaled-step seam — the ONLY thing the harness needs from Restate.
 * The entity handler adapts its `ObjectContext` (`(name, fn) => ctx.run(name,
 * fn)`); tests use an in-memory journal that replays completed steps without
 * re-running their closures (the replay-safety contract).
 */
export interface HarnessCtx {
  run<T>(name: string, action: () => T | Promise<T>): Promise<T>;
}

/** Binding data for one tool invocation (the harness mints the idempotency key). */
export interface ToolContextBinding {
  entityUrl: string;
  runId: string;
  toolUseId: string;
  /** `toolIdempotencyKey(entityUrl, runId, toolUseId)` — pre-rendered. */
  idempotencyKey: string;
  signal: AbortSignal;
}

/**
 * Produces the per-call `ToolContext` (0001:T3.1): the caller wires platform /
 * workspace clients BOUND to `binding.idempotencyKey` so every side effect
 * routes through Restate ingress exactly-once. Injected because the concrete
 * ingress clients live in the coordination/executor packages, not here.
 */
export type ToolContextFactory = (binding: ToolContextBinding) => ToolContext;

// ===========================================================================
// Options
// ===========================================================================

export interface PiHarnessOptions {
  /** Journaled-step seam over the live invocation's Restate context. */
  ctx: HarnessCtx;
  /** The LLM step client (real: ./pi-provider.ts; tests: scripted fake). */
  client: PiStepClient;
  /** Per-tool-call `ToolContext` factory (see `ToolContextFactory`). */
  toolContext: ToolContextFactory;
  /** API-level system prompt (harness config — never timeline history). */
  systemPrompt?: string;
  /** Hard cap on LLM steps per run (summarization calls excluded). Default 50. */
  maxSteps?: number;
  /**
   * Cache-inclusive context budget in tokens. Crossing it triggers
   * summarization before the next LLM step. Default: 80% of
   * `client.contextWindow` when known, else unlimited.
   */
  contextBudgetTokens?: number;
  /**
   * Max summarization folds per run. Default: unlimited
   * (`DEFAULT_MAX_SUMMARIZATIONS_PER_RUN`). With the `commitEvents` seam
   * returning allocated seqs (0002:T3.2), each fold's `replacesThroughSeq`
   * advances past the previous fold, so repeated same-run folds are correct;
   * the per-fold progress guard + the token budget keep folding self-limiting.
   * A caller WITHOUT the `commitEvents` seam gets no seqs, so its boundary
   * never advances and it folds at most once regardless of this value.
   */
  maxSummarizationsPerRun?: number;
  /** Author `run_started`/`run_finished` here (default true — see module header). */
  emitRunBoundaries?: boolean;
  /**
   * Wake source recorded in the harness-authored `run_started` (0001:T6.1 gap b).
   * The entity handler knows the true wake source (spawn / cron / system /
   * steer_degraded / message) but passes `wakeMessage: null` under the
   * pre-commit convention (agent.ts module header), which would otherwise
   * default the source to `"message"`. Passing it here threads the real source
   * WITHOUT re-committing the wake input. Falls back to
   * `input.wakeMessage?.source` then `"message"`.
   */
  wakeSource?: WakeSource;
  /** Sender entity url for the harness-authored `run_started.wake.from` (0001:T6.1 gap b). */
  wakeFrom?: string;
  /**
   * Seed for the cache-inclusive context-budget anchor (0001:T6.1 gap c): the prior
   * run's `contextTokens` (from `HarnessStateDelta`/agent K/V `usage`). Without
   * it the first step's budget check uses a pure estimate; with it the
   * summarization decision before the first LLM step reflects real prior size.
   * The anchor re-corrects to real usage after the first step regardless.
   */
  initialContextTokens?: number;
  /** Instruction appended as the user message of the summarization LLM call. */
  summarizePrompt?: string;
}

export const DEFAULT_MAX_STEPS = 50;
/**
 * Default cap on summarization folds per run (0002:T3.2). Unlimited: the
 * per-fold progress guard (a fold fires only when new context-bearing events
 * committed since the last one), the shrinking token budget, and `maxSteps`
 * bound folding in practice, and no-commit callers fold at most once.
 */
export const DEFAULT_MAX_SUMMARIZATIONS_PER_RUN = Number.POSITIVE_INFINITY;
export const DEFAULT_CONTEXT_BUDGET_FRACTION = 0.8;
export const DEFAULT_SUMMARIZE_PROMPT =
  "Context budget reached. Summarize the conversation so far into a compact briefing that " +
  "preserves: the task and its constraints, decisions made and why, work completed, work " +
  "in progress (including pending tool activity), and any open questions. The summary will " +
  "REPLACE the prior conversation as your only memory of it, so include every detail needed " +
  "to continue seamlessly. Respond with the summary only.";

// ===========================================================================
// Internal step results (journal-safe)
// ===========================================================================

type LlmStepResult =
  | { kind: "turn"; ts: string; turn: PiStepTurn }
  | { kind: "provider_error"; ts: string; code: string; message: string }
  | { kind: "aborted"; ts: string };

interface ToolStepResult {
  ts: string;
  content: ContentBlock[];
  detail?: JsonValue;
  isError: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** §6 mapping: cache-inclusive prompt size of a step (what a context gauge needs). */
function contextTokensOf(u: PiTurnUsage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

// ===========================================================================
// createPiHarness
// ===========================================================================

export function createPiHarness(opts: PiHarnessOptions): Harness {
  const {
    ctx,
    client,
    toolContext,
    systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
    maxSummarizationsPerRun = DEFAULT_MAX_SUMMARIZATIONS_PER_RUN,
    emitRunBoundaries = true,
    wakeSource,
    wakeFrom,
    initialContextTokens,
    summarizePrompt = DEFAULT_SUMMARIZE_PROMPT,
  } = opts;
  const contextBudgetTokens =
    opts.contextBudgetTokens ??
    (client.contextWindow !== undefined
      ? Math.floor(client.contextWindow * DEFAULT_CONTEXT_BUDGET_FRACTION)
      : Number.POSITIVE_INFINITY);

  return {
    kind: "native",

    async run(input: HarnessRunInput): Promise<HarnessRunResult> {
      const { entityId, runId, tools } = input;
      const msgId = (step: number): string => `msg-${runId}-s${step}`;
      const rsnId = (step: number): string => `rsn-${runId}-s${step}`;

      // The summarization fold boundary: the last context-bearing canonical
      // seq the model currently holds. Seeded from the incoming canonical
      // context and ADVANCED by `commit` as it learns the seqs the outbox
      // allocated to mid-run events (0002:T3.2) — that advance is what lets a
      // single run fold more than once (see the fold block below).
      let foldBoundarySeq: number | null = latestContextBearingSeq(input.canonicalContext);

      // --- event hand-off: commit at step boundaries when the seam exists,
      // else buffer for the end (0001:T3.1 invariant 3 — never both).
      const collected: TimelineEventInit[] = [];
      const commit = async (events: readonly TimelineEventInit[]): Promise<void> => {
        if (events.length === 0) return;
        if (input.commitEvents) {
          // A4 journal budget: keep only the last context-bearing seq from the
          // finalized return (what a later fold needs) — never the bodies.
          const finalized = await input.commitEvents(events);
          for (const ev of finalized) {
            if (isContextBearing(ev) && (foldBoundarySeq === null || ev.seq > foldBoundarySeq)) {
              foldBoundarySeq = ev.seq;
            }
          }
        } else {
          collected.push(...events);
        }
      };

      // --- usage accumulation (§6 mapping)
      const totals = { input: 0, cacheRead: 0, output: 0, llmCalls: 0, costUsd: 0, sawCost: false };
      let lastContextTokens: number | undefined;
      const accumulate = (u: PiTurnUsage): void => {
        totals.input += u.input + u.cacheWrite; // uncached input = input + cacheWrite
        totals.cacheRead += u.cacheRead;
        totals.output += u.output;
        totals.llmCalls += 1;
        if (u.costUsd !== undefined) {
          totals.costUsd += u.costUsd;
          totals.sawCost = true;
        }
        lastContextTokens = contextTokensOf(u);
      };
      const runUsage = (): RunUsage => ({
        inputTokens: totals.input,
        outputTokens: totals.output,
        ...(totals.cacheRead > 0 && { cacheReadTokens: totals.cacheRead }),
        ...(lastContextTokens !== undefined && { contextTokens: lastContextTokens }),
        steps: totals.llmCalls,
        ...(totals.sawCost && { costUsd: totals.costUsd }),
        ...(input.attempt !== undefined && { attempt: input.attempt }),
      });

      // --- provider tool specs (derived once; deterministic)
      const toolsByName = new Map<string, AnyToolDefinition>();
      for (const t of tools) toolsByName.set(t.name, t);
      const toolSpecs: PiToolSpec[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toolInputSchemaOf(t),
      }));

      // --- delta channel (fire-and-forget; only when the client streams)
      const makeOnDelta = (step: number): ((d: PiStepDelta) => void) | undefined => {
        if (client.buffered) return undefined;
        const counters = new Map<string, number>();
        return (d) => {
          let kind: "text" | "reasoning" | "tool_input";
          let ref: string;
          if (d.kind === "text") {
            kind = "text";
            ref = msgId(step);
          } else if (d.kind === "reasoning") {
            kind = "reasoning";
            ref = rsnId(step);
          } else {
            if (d.toolUseId === undefined) return; // no ref to stream toward
            kind = "tool_input";
            ref = d.toolUseId;
          }
          const idx = counters.get(ref) ?? 0;
          counters.set(ref, idx + 1);
          // Clock read is inside the journaled LLM step's closure (legal, 0001:D2);
          // deltas are ephemeral and never re-emitted on replay.
          const delta: DeltaInit = {
            kind,
            runId,
            ref,
            idx,
            ts: new Date().toISOString(),
            text: d.text,
            ...(input.attempt !== undefined && { attempt: input.attempt }),
          };
          input.emitDelta(delta);
        };
      };

      // The journaled LLM-call closure (steps + summarization). Terminal
      // provider failures and aborts are RETURNED (journaled — never
      // re-attempted, never re-billed); retryable failures THROW so Restate
      // retries this step only.
      const llmCall =
        (
          messages: readonly PiHistoryMessage[],
          stepTools: readonly PiToolSpec[],
          onDelta: ((d: PiStepDelta) => void) | undefined,
        ) =>
        async (): Promise<LlmStepResult> => {
          try {
            const turn = await client.step({
              ...(systemPrompt !== undefined && { systemPrompt }),
              messages,
              tools: stepTools,
              signal: input.signal,
              ...(onDelta !== undefined && { onDelta }),
            });
            return { kind: "turn", ts: new Date().toISOString(), turn };
          } catch (err) {
            const ts = new Date().toISOString();
            if (input.signal.aborted || isAbortError(err)) return { kind: "aborted", ts };
            const perr = toPiProviderError(err, { provider: client.provider, model: client.model });
            if (perr.retryable) throw perr;
            return { kind: "provider_error", ts, code: perr.code, message: perr.message };
          }
        };

      // --- provider context: pure assembly from canonical (0001:T3.1 rules).
      // (The fold boundary `foldBoundarySeq` is initialized above the commit
      // helper so `commit` can advance it as seqs are allocated, 0002:T3.2.)
      let messages: PiHistoryMessage[] = assemblePiContext(input.canonicalContext);
      // Budget anchoring (pi-adapter pattern): real usage re-anchors after
      // every step; estimates only bridge the gaps. Seeded from the prior run's
      // contextTokens when supplied (0001:T6.1 gap c) — anchored to the whole
      // assembled context so the pre-first-step estimate is the real prior size.
      let anchorTokens: number | undefined = initialContextTokens;
      let anchorCount = initialContextTokens !== undefined ? messages.length : 0;
      const currentContextTokens = (): number =>
        anchorTokens === undefined
          ? estimateMessageTokens(messages)
          : anchorTokens + estimateMessageTokens(messages.slice(anchorCount));

      const startedAt = await ctx.run("pi:start", () => Date.now());

      if (emitRunBoundaries) {
        await commit([
          {
            type: "run_started",
            ts: iso(startedAt),
            payload: {
              runId,
              wake: {
                source: (wakeSource ?? input.wakeMessage?.source ?? "message") as WakeSource,
                ...((input.wakeMessage?.from ?? wakeFrom) !== undefined && {
                  from: input.wakeMessage?.from ?? wakeFrom,
                }),
              },
              harness: "native",
              model: client.model,
              detail: { provider: client.provider },
            },
          },
        ]);
      }

      // Wake input (non-null form): commit + join context. (The 0001:T2.1 handler
      // convention passes null with the wake already IN canonicalContext.)
      if (input.wakeMessage !== null) {
        const wm = input.wakeMessage;
        await commit([
          {
            type: "message",
            ts: iso(startedAt),
            payload: {
              id: `wake-${runId}`,
              runId,
              role: "user",
              content: [...wm.content],
              ...(wm.from !== undefined && { from: wm.from }),
            },
          },
        ]);
        messages.push({ role: "user", content: wm.content.map((b) => ({ ...b })) });
      }

      let outcome: "success" | "error" | "interrupted" = "success";
      let summarizeCount = 0;
      // The boundary the last fold already covered — a new fold must advance
      // past it (0002:T3.2). Never re-folding the same boundary is also what
      // caps no-commit callers (whose boundary never advances) at one fold.
      let lastFoldBoundary: number | null = null;
      let lastStatus: string | undefined;
      let terminalControl: PlatformControlSignal | undefined;

      steps: for (let step = 0; ; step++) {
        if (input.signal.aborted) {
          outcome = "interrupted";
          break;
        }
        if (step >= maxSteps) {
          const ts = await ctx.run(`pi:now-maxsteps`, () => Date.now());
          await commit([
            {
              type: "error",
              ts: iso(ts),
              payload: {
                runId,
                code: "max_steps_exceeded",
                message: `run exceeded maxSteps=${maxSteps} without finishing`,
                source: "harness",
              },
            },
          ]);
          outcome = "error";
          break;
        }

        // --- steerbox drain BEFORE each LLM step (journaled — drain is I/O).
        const steered = await ctx.run(`pi:steer-${step}`, () => input.steerSource.drain());
        if (steered.length > 0) {
          await commit(
            steered.map(
              (m): TimelineEventInit => ({
                type: "message",
                ts: m.ts,
                payload: {
                  id: m.id,
                  runId,
                  role: "user",
                  content: [...m.content],
                  ...(m.from !== undefined && { from: m.from }),
                },
              }),
            ),
          );
          for (const m of steered) {
            messages.push({ role: "user", content: m.content.map((b) => ({ ...b })) });
          }
        }

        // --- context budget: summarize (own ctx.run LLM call) when over.
        // A fold fires only when new context-bearing events have committed
        // since the last fold (`foldBoundarySeq !== lastFoldBoundary`), which
        // makes repeated folds meaningful (each covers strictly more) AND caps
        // no-commit callers — whose boundary never advances — at a single fold.
        if (
          currentContextTokens() > contextBudgetTokens &&
          summarizeCount < maxSummarizationsPerRun &&
          foldBoundarySeq !== null &&
          foldBoundarySeq !== lastFoldBoundary &&
          messages.length > 0
        ) {
          const preTokens = currentContextTokens();
          // Capture the boundary NOW: the summarization committed below is
          // itself context-bearing and will advance `foldBoundarySeq` past
          // `foldSeq`, so the NEXT fold covers this summary too.
          const foldSeq: number = foldBoundarySeq;
          lastFoldBoundary = foldSeq; // never re-attempt this exact boundary
          const sumRes = await ctx.run(
            `pi:summarize-${summarizeCount}`,
            llmCall(
              [...messages, { role: "user", content: [{ type: "text", text: summarizePrompt }] }],
              [], // no tools for the summarizer
              undefined,
            ),
          );
          summarizeCount += 1;
          if (sumRes.kind === "aborted") {
            outcome = "interrupted";
            break;
          }
          if (sumRes.kind === "provider_error") {
            await commit(providerErrorEvent(runId, sumRes));
            outcome = "error";
            break;
          }
          accumulate(sumRes.turn.usage);
          // Text extraction is lossless here: a `PiStepTurn` has no image
          // blocks (assistant turns are text|thinking|toolCall), and a
          // summary is text by definition.
          const summary = sumRes.turn.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("\n\n")
            .trim();
          if (summary.length > 0) {
            await commit([
              {
                type: "summarization",
                ts: sumRes.ts,
                payload: {
                  runId,
                  summary,
                  replacesThroughSeq: foldSeq,
                  detail: { trigger: "context_budget", preTokens },
                },
              },
            ]);
            // Everything in `messages` at a fold point has already committed
            // (its allocated seqs are all <= foldSeq), so the summary stands in
            // for ALL of it — the provider context collapses to the summary
            // note. (Pre-0002 a fold could only replace the canonical prefix,
            // because mid-run events had no seq yet to fold; the seam's seq
            // return, 0002:T3.2, lifts that and enables the second fold.)
            messages = [
              { role: "user", content: [{ type: "text", text: `${SUMMARY_MARKER} ${summary}` }] },
            ];
            anchorTokens = undefined; // stale after the fold — re-estimate
            anchorCount = 0;
          }
        }

        // --- the LLM step (its own ctx.run; the journaled result is bounded).
        const res = await ctx.run(
          `pi:llm-${step}`,
          llmCall(messages, toolSpecs, makeOnDelta(step)),
        );
        if (res.kind === "aborted") {
          outcome = "interrupted";
          break;
        }
        if (res.kind === "provider_error") {
          await commit(providerErrorEvent(runId, res));
          outcome = "error";
          break;
        }
        accumulate(res.turn.usage);
        anchorTokens = contextTokensOf(res.turn.usage);

        // --- canonical events for this step (committed at the boundary).
        const stepEvents: TimelineEventInit[] = [];
        const thinking = res.turn.content.filter(
          (b): b is Extract<PiStepTurn["content"][number], { type: "thinking" }> =>
            b.type === "thinking",
        );
        if (thinking.length > 0) {
          const text = thinking.map((b) => b.text).join("\n\n");
          const encrypted = thinking.find((b) => b.redacted === true && b.signature)?.signature;
          stepEvents.push({
            type: "reasoning",
            ts: res.ts,
            payload: {
              id: rsnId(step),
              runId,
              text,
              ...(encrypted !== undefined && { encrypted }),
            },
          });
        }
        const textBlocks = res.turn.content.filter(
          (b): b is Extract<PiStepTurn["content"][number], { type: "text" }> => b.type === "text",
        );
        if (textBlocks.length > 0) {
          stepEvents.push({
            type: "message",
            ts: res.ts,
            payload: {
              id: msgId(step),
              runId,
              role: "assistant",
              content: textBlocks.map((b) => ({ type: "text" as const, text: b.text })),
            },
          });
        }
        const toolCalls = res.turn.content.filter(
          (b): b is Extract<PiStepTurn["content"][number], { type: "toolCall" }> =>
            b.type === "toolCall",
        );
        for (const tc of toolCalls) {
          stepEvents.push({
            type: "tool_call",
            ts: res.ts,
            payload: { runId, toolUseId: tc.toolUseId, name: tc.name, input: tc.input },
          });
        }
        await commit(stepEvents);

        // Same-run provider context keeps the turn verbatim (incl. thinking
        // with signatures — required by some providers during tool loops;
        // canonical `reasoning` stays display-only across wakes).
        messages.push({
          role: "assistant",
          content: res.turn.content.map((b) =>
            b.type === "toolCall"
              ? { type: "toolCall" as const, toolUseId: b.toolUseId, name: b.name, input: b.input }
              : b.type === "thinking"
                ? {
                    type: "thinking" as const,
                    text: b.text,
                    ...(b.signature !== undefined && { signature: b.signature }),
                    ...(b.redacted !== undefined && { redacted: b.redacted }),
                  }
                : { type: "text" as const, text: b.text },
          ),
        });
        anchorCount = messages.length;

        if (toolCalls.length === 0) {
          // stopReason stop/length with no tool work — the turn is over.
          break;
        }

        // --- tool calls: each executes as its own journaled step, through
        // the injected ToolContext bound to the exactly-once idempotency key.
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]!;
          // 0002:T3.3: per-tool-call span, CHILD of the active `harness.run`
          // span (coordination/agent.ts opens it with startActiveSpan). Created
          // INSIDE the journaled step so it is not re-created on replay (spans
          // are ephemeral, like deltas); no-op unless a tracer is registered.
          const toolRes = await ctx.run(`pi:tool-${step}-${i}`, () =>
            getTracer().startActiveSpan(
              "tool.call",
              {
                attributes: {
                  "teaspill.tool.name": tc.name,
                  "teaspill.tool.use_id": tc.toolUseId,
                },
              },
              async (tspan) => {
                try {
                  const r = await executeToolCall({
                    tool: toolsByName.get(tc.name),
                    call: tc,
                    entityId,
                    runId,
                    signal: input.signal,
                    toolContext,
                  });
                  tspan.setAttribute("teaspill.tool.outcome", r.isError ? "error" : "success");
                  return r;
                } catch (err) {
                  tspan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
                  throw err;
                } finally {
                  tspan.end();
                }
              },
            ),
          );
          await commit([
            {
              type: "tool_result",
              ts: toolRes.ts,
              payload: {
                runId,
                toolUseId: tc.toolUseId,
                name: tc.name,
                content: toolRes.content,
                ...(toolRes.detail !== undefined && { detail: toolRes.detail }),
                isError: toolRes.isError,
              },
            },
          ]);
          messages.push({
            role: "toolResult",
            toolUseId: tc.toolUseId,
            toolName: tc.name,
            content: toolRes.content.map((b) =>
              b.type === "text"
                ? { type: "text" as const, text: b.text }
                : { type: "image" as const, mimeType: b.mimeType, data: b.data },
            ),
            isError: toolRes.isError,
          });
          anchorCount = messages.length;

          const control = readPlatformControlSignal({
            content: toolRes.content,
            ...(toolRes.detail !== undefined && { detail: toolRes.detail }),
            ...(toolRes.isError && { isError: true }),
          });
          if (control) {
            if (control.kind === "set_status") lastStatus = control.status;
            else terminalControl = control; // wait / finish — end after this step's tools
          }
        }

        if (terminalControl && isTerminalControl(terminalControl)) {
          break steps; // outcome stays "success" — wait/finish are clean ends
        }
      }

      const endedAt = await ctx.run("pi:end", () => Date.now());
      if (emitRunBoundaries) {
        const detail: JsonValue = {
          ...(terminalControl !== undefined && {
            control: terminalControl as unknown as JsonValue,
          }),
          ...(lastStatus !== undefined && { status: lastStatus }),
        };
        await commit([
          {
            type: "run_finished",
            ts: iso(endedAt),
            payload: {
              runId,
              outcome,
              usage: runUsage(),
              durationMs: Math.max(0, endedAt - startedAt),
              ...(Object.keys(detail as object).length > 0 && { detail }),
            },
          },
        ]);
      }

      return {
        events: collected,
        stateDelta: {
          ...(lastContextTokens !== undefined && { contextTokens: lastContextTokens }),
        },
        usage: runUsage(),
      };
    },
  };
}

// ===========================================================================
// Internals
// ===========================================================================

function providerErrorEvent(
  runId: string,
  res: { ts: string; code: string; message: string },
): TimelineEventInit[] {
  return [
    {
      type: "error",
      ts: res.ts,
      payload: { runId, code: res.code, message: res.message, source: "provider" },
    },
  ];
}

/**
 * One tool call, executed inside its journaled step. Unknown tools, input
 * validation failures, and `execute` throws all journal as `isError` results
 * the MODEL sees (electric's proven tool semantics) — they never fail the
 * run. Transient-infrastructure retry belongs to the ingress client inside
 * the invocation; whatever escapes here is a real tool failure.
 */
async function executeToolCall(args: {
  tool: AnyToolDefinition | undefined;
  call: { toolUseId: string; name: string; input: JsonValue };
  entityId: string;
  runId: string;
  signal: AbortSignal;
  toolContext: ToolContextFactory;
}): Promise<ToolStepResult> {
  const { tool, call, entityId, runId, signal } = args;
  const errorResult = (message: string): ToolStepResult => ({
    ts: new Date().toISOString(),
    content: [{ type: "text", text: message }],
    isError: true,
  });

  if (!tool) {
    return errorResult(
      `Unknown tool "${call.name}". Available tools are listed in your tool definitions.`,
    );
  }
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    return errorResult(`Invalid input for tool "${call.name}": ${parsed.error.message}`);
  }
  const idempotencyKey = toolIdempotencyKey(entityId, runId, call.toolUseId);
  const toolCtx = args.toolContext({
    entityUrl: entityId,
    runId,
    toolUseId: call.toolUseId,
    idempotencyKey,
    signal,
  });
  try {
    const result: ToolExecutionResult = await tool.execute(parsed.data as never, toolCtx);
    return {
      ts: new Date().toISOString(),
      content: result.content,
      ...(result.detail !== undefined && { detail: result.detail }),
      isError: result.isError ?? false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Tool "${call.name}" failed: ${message}`);
  }
}

/**
 * Derive the provider-facing JSON schema from a tool's zod schema (zod v4's
 * native converter; it handles the recursive `jsonValueSchema` via
 * $defs/$ref). Kept as a tiny exported seam so pi-provider/tests share it.
 */
export function toolInputSchemaOf(tool: AnyToolDefinition): JsonValue {
  return z.toJSONSchema(tool.schema as never, { target: "draft-2020-12" }) as JsonValue;
}
