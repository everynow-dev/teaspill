/**
 * Agent virtual object — runtime context seam + K/V layout (T2.1).
 *
 * This module holds the pieces of the agent object that everything else in
 * the package (handlers in ./agent.ts, seams in ./agent-seams.ts, tests)
 * shares: the structural context interfaces the handler logic is written
 * against (the cron.ts `CronRuntimeCtx` pattern, extended with the A4
 * interrupt seam), the documented K/V layout, and small pure helpers.
 *
 * ## Why a structural context (same rationale as cron.ts)
 *
 * Handler LOGIC is written against `AgentRuntimeCtx` / `AgentSharedRuntimeCtx`
 * — small structural subsets of `restate.ObjectContext` /
 * `restate.ObjectSharedContext` plus the A4 interrupt-race seam — so it can
 * be unit-tested against in-memory fakes (agent.test.ts) without a live
 * Restate server. The real `restate.object(...)` wiring in ./agent.ts is a
 * thin adapter with no independent logic. What the fakes canNOT cover (real
 * cancellation delivery, `explicitCancellation` semantics, replay of a
 * crashed `ctx.run`, shared-handler K/V visibility timing) is a live-server
 * conformance item (T6.3/T9.1), exactly as SPIKE-RESTATE.md prescribes for
 * the `@experimental` cancellation API.
 */

import * as restate from "@restatedev/restate-sdk";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { RunUsage, TimelineEvent } from "@teaspill/schema";

// ---------------------------------------------------------------------------
// Entity status (D7 lifecycle)
// ---------------------------------------------------------------------------

/**
 * D7: active → idle → archived.
 * - `active` — a wake (exclusive invocation) is being processed right now.
 * - `idle` — alive in Restate K/V, waiting for the next wake.
 * - `archived` — K/V cleared, snapshot in the catalog (T8.1). Resurrection on
 *   a new message rehydrates from the catalog snapshot and continues the same
 *   seq counter from `head_seq`.
 */
export type EntityStatus = "active" | "idle" | "archived";

// ---------------------------------------------------------------------------
// K/V layout (D1/D2 — "Restate K/V = live entity state, the only store
// consulted for control flow")
// ---------------------------------------------------------------------------

/**
 * The complete K/V layout of an agent virtual object. Key names are the
 * literal Restate state keys. Layout per PLAN T2.1 / D2:
 * `{ status, seq, outbox[], context[], workspaceRef, subscribers[],
 *    parentRef, usage, currentInvocationId? }`
 * plus two documented additive keys required by frozen downstream contracts
 * (`harness` — D5 layer-2 continuation state; `archiveEpoch` — the D7
 * idle-timer generation guard). Neither contradicts D2; both are live state
 * consulted only for control flow.
 */
export const AGENT_KV = {
  /** `EntityStatus` — D7 lifecycle position. Absent ⇒ never spawned. */
  status: "status",
  /**
   * `number` — the NEXT unallocated canonical seq (so `seq - 1` is the head
   * seq / last allocated). 0-based gapless per entity (A1). Allocated ONLY by
   * the outbox seam (`ProjectionOutbox.stage`) inside this object's exclusive
   * handlers — single-writer per key makes the increment atomic with the
   * event that consumes it (D3). Harnesses/handlers never assign seq; they
   * produce `TimelineEventInit` and the outbox finalizes.
   */
  seq: "seq",
  /**
   * `TimelineEvent[]` — the pending projection outbox (D3): events whose seq
   * is allocated but whose append to the durable stream is not yet confirmed.
   * Trimmed only after confirmed append; retried (in order, from the first
   * unconfirmed) at the start of the next invocation. R4 budget: events are
   * staged and flushed in bounded chunks (see `commitEventsChunked`) so this
   * value stays well under the ~1 MiB journal-entry budget (A4).
   */
  outbox: "outbox",
  /**
   * `TimelineEvent[]` — the bounded conversation context (D1), in ascending
   * seq order: exactly the context-bearing canonical events (message /
   * tool_call / tool_result / summarization, plus the owning harness's opaque
   * records), with the summarization fold already applied
   * (`selectContextEvents`). This is what `HarnessRunInput.canonicalContext`
   * is fed from — never the stream (D1: streams are never read for control
   * flow). Summarization is the bounding mechanism: a `summarization` event
   * drops everything it replaces from this value.
   */
  context: "context",
  /** `string` — workspace key `<tenant>/<name>` chosen at spawn (D4: never switched). Absent when the agent has no workspace. */
  workspaceRef: "workspaceRef",
  /**
   * `string[]` — entity urls subscribed to this entity's changes (D2
   * pub/sub). Notified via the notifier seam after each wake; subscription
   * management (subscribe/unsubscribe, debounce, dedupe) is T2.3.
   */
  subscribers: "subscribers",
  /** `string | null` — parent entity url (D2 spawn carries the parent's key), null for root entities. */
  parentRef: "parentRef",
  /** `RunUsage` — cumulative usage across all runs (sums; `contextTokens` is latest-wins). */
  usage: "usage",
  /**
   * `string` — the Restate invocation id of the wake currently in flight
   * (A4 interrupt target). Set first thing in every exclusive wake, cleared
   * in `finally`. The shared `signal` handler reads it live (shared handlers
   * see in-flight K/V writes, SPIKE §a-2) and `ctx.cancel()`s it.
   */
  currentInvocationId: "currentInvocationId",
  /**
   * `JsonValue` — opaque per-harness continuation state
   * (`HarnessStateDelta.harness`, D5): the CASDK harness stores
   * `{ sessionId, seqStamp }`, the native harness typically nothing.
   * Additive extension to the PLAN T2.1 key list (required by the frozen
   * harness interface).
   */
  harness: "harness",
  /**
   * `number` — generation guard for the idle→archive self-scheduled check
   * (D7/T8.1), same pattern as cron.ts: every wake bumps it and issues a
   * delayed `archiveTick({ epoch })` self-send; a tick whose epoch doesn't
   * match current K/V is stale (activity happened since) and is a no-op.
   * Additive extension to the PLAN T2.1 key list.
   */
  archiveEpoch: "archiveEpoch",
  /**
   * `boolean` — the T2.5 `pause`/`resume` runtime flag (D8 control verb).
   * When truthy, `handleMessage` QUEUES the wake input into `pausedMailbox`
   * without running the harness (checked at invocation start); `resume`
   * clears it and re-enqueues the mailbox. Deliberately SEPARATE from the D7
   * `status` enum (`active|idle|archived`, frozen in `entities.status`):
   * pause is a live control-flow flag, not a catalog lifecycle position, so
   * a paused entity's catalog status stays `idle` (A5 freeze is not
   * touched). Additive extension to the PLAN T2.1 key list.
   */
  paused: "paused",
  /**
   * `AgentMessageInput[]` — wake inputs received while `paused` is set,
   * held (not processed, no events recorded) until `resume` drains them back
   * onto the mailbox as ordinary `message` self-sends. Empty/absent ⇒ nothing
   * queued. Bounded by the same R4 budget as any K/V value; a pathological
   * flood while paused is the caller's concern (gateway backpressure, T1.2).
   */
  pausedMailbox: "pausedMailbox",
} as const;

export type AgentKvKey = (typeof AGENT_KV)[keyof typeof AGENT_KV];

// ---------------------------------------------------------------------------
// Interrupt error (A4 seam)
// ---------------------------------------------------------------------------

/**
 * Thrown out of `AgentRuntimeCtx.raceInterrupt` when the in-flight wake is
 * cancelled by the shared `signal(interrupt)` handler (T2.5's verb builds on
 * this). Extends `TerminalError` so Restate never retries the interrupted
 * attempt; the wake handler catches it and — because the object runs with
 * `explicitCancellation: true` (A4) — can still perform durable cleanup
 * steps (control event, run_finished, outbox flush) before completing
 * successfully. The entity stays live and immediately messageable.
 */
export class AgentInterruptedError extends restate.TerminalError {
  constructor(message = "run interrupted") {
    super(message, { errorCode: 409 });
    this.name = "AgentInterruptedError";
  }
}

// ---------------------------------------------------------------------------
// Runtime contexts (structural subsets of the Restate contexts + A4 seam)
// ---------------------------------------------------------------------------

/** The subset of `restate.ObjectContext` (+ A4 interrupt seam) the exclusive agent handlers use. */
export interface AgentRuntimeCtx {
  /** The virtual-object key = the instance id (`<id>` of the entity url, docs/addressing.md §6). */
  readonly key: string;
  /**
   * `ctx.request().id` — recorded into `AGENT_KV.currentInvocationId` at wake
   * start so the shared `signal` handler can target this invocation with
   * `ctx.cancel` (SPIKE §a-3). Also used as the deterministic `runId`
   * (stable across Restate retry attempts of the same invocation).
   */
  readonly invocationId: string;
  /**
   * A4 merged abort signal:
   * `AbortSignal.any([interruptAbort.signal, ctx.request().attemptCompletedSignal])`.
   * MUST be passed into every long-running closure (the harness run, tool
   * calls) — without it an aborted attempt's closure zombies on, overlapping
   * its own retries (SPIKE §e-3).
   */
  readonly runAbortSignal: AbortSignal;
  /**
   * T8.2 trace propagation: the parent OTel `Context` extracted from the wake
   * envelope's `traceparent`/`tracestate` fields (the gateway injects them onto
   * the ingress send — a Restate one-way send drops HTTP headers). `runWake`
   * opens its `agent.wake` span under this so the trace links back to the
   * caller. Optional — fakes and pre-T8.2 call sites omit it (span becomes a
   * normal root).
   */
  readonly otelContext?: OtelContext;
  get<T>(name: string): Promise<T | null>;
  set<T>(name: string, value: T): void;
  clear(name: string): void;
  run<T>(name: string, action: () => T | Promise<T>): Promise<T>;
  /**
   * Race `work` against the interrupt-cancellation (the SPIKE §a
   * `explicitCancellation` pattern): when the shared `signal(interrupt)`
   * handler cancels this invocation, the adapter aborts the controller
   * behind `runAbortSignal` (reaching the live LLM/tool call, ~20 ms
   * code-verified) and rejects with `AgentInterruptedError`. Durable steps
   * still work afterwards — that is what `explicitCancellation: true` buys.
   */
  raceInterrupt<T>(work: Promise<T>): Promise<T>;
  /**
   * Arm interrupt→abort WITHOUT racing/throwing (T6.1 step-durable path).
   *
   * `raceInterrupt` is the T2.1 pattern for a harness that runs inside ONE
   * `ctx.run` and must be yanked out on interrupt (it rejects with
   * `AgentInterruptedError`). A step-durable harness (the compiled native
   * harness, T3.2) instead journals its OWN steps and treats an abort as a
   * NORMAL outcome — it breaks its loop, commits `run_finished(interrupted)`,
   * and resolves. For it, the interrupt must only ABORT `runAbortSignal`
   * (reaching the live LLM/tool call) and let the harness wind down; a throwing
   * race would double-author the run_finished the harness already commits.
   *
   * Calling this arms `ctx.cancellation() → interruptAbort.abort()` once
   * (idempotent). Optional so the T2.1 fakes/handlers that never take the
   * step-durable path need not implement it.
   */
  armInterruptAbort?(): void;
  genericSend(call: {
    service: string;
    method: string;
    key?: string;
    parameter: unknown;
    delay?: number;
  }): void;
}

/**
 * The subset of `restate.ObjectSharedContext` the shared `signal` handler
 * uses. Shared handlers run truly concurrently with a busy exclusive handler
 * and see its in-flight K/V writes (SPIKE §a-1/2); they cannot write K/V —
 * control effects are limited to reading state, cancelling invocations, and
 * one-way sends. This constraint is the design boundary T2.5 inherits.
 */
export interface AgentSharedRuntimeCtx {
  readonly key: string;
  get<T>(name: string): Promise<T | null>;
  /**
   * `ctx.cancel(invocationId)` — cancel the (possibly in-flight) exclusive
   * invocation. Cancelling an already-completed invocation is a harmless
   * 409 on the server (SPIKE §a-3); a queued not-yet-started invocation is
   * removed from the inbox (SPIKE §a-6).
   */
  cancelInvocation(invocationId: string): void;
  genericSend(call: {
    service: string;
    method: string;
    key?: string;
    parameter: unknown;
    delay?: number;
  }): void;
}

// ---------------------------------------------------------------------------
// Usage accumulation (pure)
// ---------------------------------------------------------------------------

export const ZERO_RUN_USAGE: RunUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Fold one run's usage into the cumulative K/V `usage` value. Counters sum;
 * `contextTokens` is latest-wins (it is a gauge, not a counter). Pure.
 */
export function accumulateUsage(total: RunUsage | null, run: RunUsage): RunUsage {
  const t = total ?? ZERO_RUN_USAGE;
  const out: RunUsage = {
    inputTokens: t.inputTokens + run.inputTokens,
    outputTokens: t.outputTokens + run.outputTokens,
  };
  const cacheRead = (t.cacheReadTokens ?? 0) + (run.cacheReadTokens ?? 0);
  if (cacheRead > 0) out.cacheReadTokens = cacheRead;
  const steps = (t.steps ?? 0) + (run.steps ?? 0);
  if (steps > 0) out.steps = steps;
  const costUsd = (t.costUsd ?? 0) + (run.costUsd ?? 0);
  if (costUsd > 0) out.costUsd = costUsd;
  const contextTokens = run.contextTokens ?? t.contextTokens;
  if (contextTokens !== undefined) out.contextTokens = contextTokens;
  return out;
}

// ---------------------------------------------------------------------------
// Head-seq helper (pure)
// ---------------------------------------------------------------------------

/** `seq` K/V value (next unallocated) → head seq (last allocated), or null if nothing allocated yet. */
export function headSeqOf(nextSeq: number | null): number | null {
  return nextSeq === null || nextSeq === 0 ? null : nextSeq - 1;
}

/** Type guard: an ordered `TimelineEvent[]` K/V value (defensive narrowing helper for tests/tools). */
export function isTimelineEventArray(v: unknown): v is TimelineEvent[] {
  return Array.isArray(v);
}
