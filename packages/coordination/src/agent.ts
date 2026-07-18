/**
 * `agent.<type>` — 0001:T2.1: the agent virtual object skeleton.
 *
 * Implements 0001:D2's coordination heart: agent = Restate virtual object, service
 * `agent.<type>` keyed by instance id (0001:A3, docs/addressing.md §6); one wake =
 * one exclusive invocation; single-writer per key; long chats = many
 * invocations with bounded journals (0001:R4/0001:A4).
 *
 * ## Template, not instance (the 0001:T6.1 seam)
 *
 * This module is a GENERIC TEMPLATE: `createAgentObject(config)` produces one
 * Restate virtual-object definition for one agent type. The Agents SDK
 * (0001:T6.1 `defineAgent`) specializes it by supplying the config — `entityType`
 * (which becomes the service name `agent.<type>`), the `Harness` (0001:D5),
 * tools, spawn/message validators (from its zod schemas), and the real seam
 * implementations (outbox 0001:T2.2, notifier 0001:T2.3, steer source 0001:T2.6). 0001:T2.1
 * ships working STUB seams (./agent-seams.ts) so the template runs and is
 * tested today; nothing in this file changes when the real seams land.
 *
 * ## Handlers
 *
 * - `spawn(input)` — first wake. Initializes K/V, writes `entity_spawned`
 *   at seq 0 through the outbox, then runs a normal wake. A repeated spawn
 *   on an existing key is an idempotent no-op reattach (addressing §3.3).
 * - `message(input)` — ordinary wake (typed variants: plain message,
 *   `child_finished` from a child, `subscription_update` from an observed
 *   entity).
 * - `signal(sig)` — **SHARED handler** (concurrent with a busy exclusive
 *   run; 0001:A4/SPIKE §a). `interrupt` reads `currentInvocationId` from K/V —
 *   visible live while the exclusive wake runs — and `ctx.cancel`s it. This
 *   is the seam 0001:T2.5 builds the full verb API on; see `handleSignal`.
 * - `archiveTick(msg)` — the idle→archive self-scheduled check (0001:D7),
 *   generation-guarded like cron.ts. The archive body itself is 0001:T8.1; the
 *   seq/head_seq contract it must honor is documented at `handleArchiveTick`.
 * - `reconcileProbe` (SHARED) / `reconcileFlush` / `reconcileRecovery`
 *   (EXCLUSIVE) — the 0001:A9 reconciler seams (0002:T2.1): cheap drift probe,
 *   flush re-drive, and the catastrophic epoch-reset executor. Logic lives in
 *   ./projection-outbox.ts (the module that owns the outbox K/V).
 *
 * ## Invocation flow (every wake)
 *
 * validate → apply (record wake input events) → run harness (one `ctx.run`,
 * raced against interrupt-cancellation, abort-signal-merged per 0001:A4) →
 * collect events → project via the outbox seam in bounded chunks (0001:T2.2,
 * 0001:A1/0001:R4) → notify seam (0001:T2.3) → re-arm the archive timer.
 *
 * ## 0001:A4 discipline baked in
 *
 * - the object registers with `explicitCancellation: true` (MANDATORY —
 *   without it, post-interrupt durable cleanup is impossible and the
 *   in-flight LLM closure zombies at full cost);
 * - the harness `ctx.run` closure receives
 *   `AbortSignal.any([interruptAbort, attemptCompletedSignal])`;
 * - no naked clock/random reads outside `ctx.run` (`now` is journaled;
 *   `runId` derives from the invocation id, which is replay-stable);
 * - `inactivityTimeout`/`abortTimeout` are set per handler and must exceed
 *   the worst-case harness step latency (config).
 *
 * ## Wake-input convention (harness contract note)
 *
 * The HANDLER records the wake input as canonical `message` event(s) BEFORE
 * the harness runs, so `canonicalContext` already ends on the wake input and
 * `HarnessRunInput.wakeMessage` is passed as `null` (the interface's
 * "continuation wake" form). Harnesses therefore never have to merge a
 * separate wake message, and the timeline shows the user input ahead of
 * `run_started`'s events.
 */

import * as restate from "@restatedev/restate-sdk";
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  type Context as OtelContext,
} from "@opentelemetry/api";
import type {
  ContentBlock,
  ControlVerb,
  JsonValue,
  RunOutcome,
  RunUsage,
  TimelineEvent,
  TimelineEventInit,
  WakeSource,
} from "@teaspill/schema";
import {
  NOOP_COORDINATION_METRICS,
  getTracer,
  takeTraceContext,
  type CoordinationMetrics,
} from "./otel.js";
import type { AnyToolDefinition, EmitDelta, Harness, SteerSource } from "@teaspill/harness-native";
import { selectContextEvents } from "@teaspill/harness-native";
import {
  AGENT_KV,
  AgentInterruptedError,
  ZERO_RUN_USAGE,
  accumulateUsage,
  headSeqOf,
  type AgentRuntimeCtx,
  type AgentSharedRuntimeCtx,
  type EntityStatus,
} from "./agent-runtime.js";
import {
  DEFAULT_OUTBOX_CHUNK_SIZE,
  commitEventsChunked,
  emptySteerSource,
  noopEmitDelta,
  parseEntityUrlLite,
  type AgentNotifier,
  type AgentSendPayload,
  type ArchiveCatalog,
  type ChildFinishedNotification,
  type ProjectionOutbox,
} from "./agent-seams.js";
import {
  addSubscriber,
  handleSubscriberNotifyTick,
  notifyParentOrDeadLetter,
  removeSubscriber,
  scheduleSubscriberNotify,
  spawnChild,
  type EntityDirectory,
  type NotifyTickMessage,
  type NotifyTickResult,
  type SpawnChildRequest,
  type SubscribeResult,
  type UnsubscribeResult,
} from "./messaging.js";
import {
  OUTBOX_KV,
  handleReconcileFlush,
  handleReconcileProbe,
  handleReconcileRecovery,
  type ReconcileRecoveryInput,
  type ReconcileRecoveryResult,
} from "./projection-outbox.js";
import type { EntityProbe, FlushDriveOutcome } from "./reconciler.js";
import type { ArchiveSnapshotState } from "./archive-snapshot.js";
import { drainAtWakeStart } from "./steer.js";
import {
  applyArchive,
  handleArchive,
  handleInterrupt,
  handlePause,
  handleResume,
  queueIfPaused,
  type ArchiveResult,
  type ControlInput,
  type InterruptResult,
  type PauseResult,
  type ResumeResult,
} from "./control.js";

// ---------------------------------------------------------------------------
// Naming (0001:A3 / docs/addressing.md §6)
// ---------------------------------------------------------------------------

export const AGENT_SERVICE_PREFIX = "agent." as const;

const TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Restate service name for an agent type: `agent.<type>` (0001:A3-confirmed). */
export function agentServiceName(entityType: string): string {
  if (!TYPE_RE.test(entityType)) {
    throw new Error(`invalid agent type ${JSON.stringify(entityType)} (must match ${TYPE_RE})`);
  }
  return `${AGENT_SERVICE_PREFIX}${entityType}`;
}

/** Canonical entity url for this object instance (docs/addressing.md §2). */
export function agentEntityUrl(tenant: string, entityType: string, id: string): string {
  if (!TENANT_RE.test(tenant)) throw new Error(`invalid tenant ${JSON.stringify(tenant)}`);
  if (!TYPE_RE.test(entityType)) throw new Error(`invalid agent type ${JSON.stringify(entityType)}`);
  if (!ID_RE.test(id)) {
    throw new restate.TerminalError(`invalid instance id ${JSON.stringify(id)} (must match ${ID_RE})`);
  }
  return `/t/${tenant}/a/${entityType}/${id}`;
}

// ---------------------------------------------------------------------------
// Config (what 0001:T6.1 `defineAgent` compiles onto this template)
// ---------------------------------------------------------------------------

/**
 * What a step-durable `buildHarness` (0001:T6.1) receives to construct the harness
 * for one wake. The compiled native harness uses `ctx` as its `HarnessCtx`
 * (journaled-step seam) AND to bind its per-tool-call ingress clients; it
 * threads `wakeSource`/`wakeFrom` into its own `run_started` (gap b) and seeds
 * its context-budget anchor from `priorContextTokens` (gap c).
 */
export interface HarnessBuildContext {
  /**
   * The live wake's runtime ctx. Doubles as the harness's journaled-step seam
   * (it exposes `run(name, fn)`) and the root for building ingress-bound tool
   * clients (`genericSend`, keyed idempotency).
   */
  ctx: AgentRuntimeCtx;
  entityId: string;
  /** Deterministic run id (stable across Restate retries of this invocation). */
  runId: string;
  /** True wake source, for the harness-authored `run_started` (gap b). */
  wakeSource: WakeSource;
  /** Sender entity url, when the wake carried one (gap b). */
  wakeFrom?: string;
  /** Prior run's context size (agent K/V `usage.contextTokens`) for budget seeding (gap c). */
  priorContextTokens?: number;
}

export interface AgentObjectConfig {
  /** Agent type; realizes the Restate service `agent.<type>` (0001:A3). Charset per addressing §2.3. */
  entityType: string;
  /** Deployment tenant (addressing §1). Default `"default"`. */
  tenant?: string;
  /**
   * The harness that owns the LLM loop (0001:D5). Used by the 0001:T2.1 STATIC path:
   * `runWake` wraps `harness.run` in one `ctx.run` and authors the run
   * boundaries around it. Correct for a non-step-durable harness (the stub).
   *
   * For a STEP-DURABLE harness (the compiled native/pi harness, 0001:T3.2) set
   * `buildHarness` instead — see there. `harness` still names the harness KIND
   * (`run_started.payload.harness`), so keep it set even when `buildHarness` is
   * supplied (0001:T6.1 `defineAgent` sets both).
   */
  harness: Harness;
  /**
   * Step-durable harness constructor (0001:T6.1, the 0001:G8 run-boundary resolution).
   *
   * When set, `runWake` takes the STEP-DURABLE path instead of the static one:
   * it builds the harness PER WAKE with the live invocation's runtime ctx (the
   * harness journals its OWN `ctx.run` steps, so it must NOT be wrapped in an
   * outer `ctx.run`), hands it a `commitEvents` seam so canonical events commit
   * at every step boundary (0001:D5), and does NOT author `run_started`/
   * `run_finished` — the harness authors them itself (its `emitRunBoundaries`
   * stays true; this is the ONE-authorship fix for the 0001:T3.2 double-authoring
   * gap). Interrupt reaches the harness via `runAbortSignal`
   * (`armInterruptAbort`), and the harness winds down + authors
   * `run_finished(interrupted)` rather than throwing.
   *
   * `defineAgent`'s `native(...)` selection compiles into this; `harness`
   * (above) is the KIND descriptor for the same harness.
   */
  buildHarness?: (build: HarnessBuildContext) => Harness;
  tools?: readonly AnyToolDefinition[];
  /** Projection outbox seam — the ONLY seq allocator + stream writer (0001:T2.2). */
  outbox: ProjectionOutbox;
  /** Messaging/notify seam (0001:T2.3). */
  notifier: AgentNotifier;
  /**
   * Entity-status lookup for dead-letter detection (0001:T2.3, 0001:D1 catalog). When
   * set, an undeliverable `child_finished` back-send (parent gone/archived)
   * stages an `error` event on this entity's own timeline instead of vanishing
   * (0001:D2 "never silent"); the arbitrary `send` verb uses it too (messaging.ts
   * `sendToAgent`). When absent, notifications are best-effort fire-and-forget
   * (the 0001:T2.1 behavior — no dead-letter).
   */
  directory?: EntityDirectory;
  /**
   * Debounce window for subscriber notifications (0001:T2.3, 0001:D2 pub/sub). `> 0`:
   * a wake that changed observable state arms a coalescing `notifyTick`
   * self-send (delayed by this many ms) instead of fanning out inline, so a
   * burst of wakes collapses to one `subscription_update` per subscriber.
   * `0`: notify inline every wake (no debounce). Default
   * `DEFAULT_SUBSCRIBER_NOTIFY_DEBOUNCE_MS`.
   */
  subscriberNotifyDebounceMs?: number;
  /**
   * Observability recorder (0001:T8.2). Default no-op. When set, `runWake` records
   * `wakes_per_sec` (one per wake) and `llm_token_spend` (from the run usage);
   * the `agent.wake`/`harness.run` spans are always emitted through the global
   * tracer (a no-op unless a provider is registered — the gateway `otel.ts`
   * pattern). Injected so it unit-tests against a fake meter.
   */
  metrics?: CoordinationMetrics;
  /** Steerbox drain (0001:T2.6). Default: nothing ever queued. */
  steerSource?: SteerSource;
  /** Token-delta sink (platform wiring, 0001:T5.1). Default: no-op. */
  emitDelta?: EmitDelta;
  /** 0001:T6.1 hook: validate/normalize spawn args (throw `TerminalError` to reject). */
  validateSpawnArgs?: (args: JsonValue | undefined) => JsonValue | undefined;
  /** 0001:T6.1 hook: validate/normalize an inbound message (throw `TerminalError` to reject). */
  validateMessage?: (input: AgentMessageInput) => AgentMessageInput;
  /**
   * 0001:D7 archive-of-record seam (0001:T8.1): persists the `archived_snapshot` JSONB at
   * archive time (`applyArchive`) and loads it back for RESURRECTION on the
   * first message to an archived entity (`resurrectFromCatalog`). Real impl
   * `createDrizzleArchiveCatalog` (projection-catalog.ts). When ABSENT: archive
   * still writes the snapshot to the stream, but nothing is persisted to the
   * catalog and an archived entity CANNOT resurrect (its `message` handler
   * stays a terminal "no live state" — the pre-0001:T8.1 behavior). Deployments that
   * want the 0001:D7 lifecycle wire this.
   */
  archiveCatalog?: ArchiveCatalog;
  /** Write-time cap on the archive snapshot's serialized size (0001:D7 bounded context). Default 256 KiB. */
  archiveSnapshotMaxBytes?: number;
  /**
   * Deterministic per-wake hook (0001:T6.1 `defineAgent.onWake`, wired here in 0001:T8.1).
   * Runs INSIDE the wake, after the wake input is committed and folded into
   * context, and BEFORE the LLM harness. It may emit canonical events, send to
   * / spawn other agents, and read the bounded context — all through the
   * `OnWakeContext` seam (which journals its I/O, 0001:D2). It then either HANDLES
   * the wake fully (`{ handled: true }` ⇒ the harness does not run — a
   * deterministic, non-LLM agent, the 0001:T6.3 conformance driver) or HANDS OFF
   * (falsy / `{ handled: false }` ⇒ the harness runs next, with onWake's events
   * already ahead of it). See the `OnWakeHandler` contract. When absent, wakes
   * go straight to the harness (the pre-0001:T8.1 behavior).
   */
  onWake?: OnWakeHandler;
  /** Idle window before the archive check fires (0001:D7). `0` disables. Default 30 min. */
  idleArchiveDelayMs?: number;
  /** Events per bounded outbox stage+flush chunk (0001:R4). Default 16. */
  outboxChunkSize?: number;
  /**
   * Per-handler Restate timeouts (0001:A4 rule 3): MUST exceed the worst-case
   * harness step latency, or aborted attempts zombie-loop. Defaults: 10 min
   * inactivity, 10 min abort.
   */
  inactivityTimeoutMs?: number;
  abortTimeoutMs?: number;
  /**
   * Opaque-event origins retained in the K/V context for the owning
   * harness's cold rebuild (0001:T7.1). Default: `[harness.kind]`.
   */
  contextOpaqueOrigins?: readonly string[];
}

export const DEFAULT_IDLE_ARCHIVE_DELAY_MS = 30 * 60_000;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_ABORT_TIMEOUT_MS = 10 * 60_000;
/** Coalescing window for subscriber notifications (0001:T2.3, 0001:D2 debounce). */
export const DEFAULT_SUBSCRIBER_NOTIFY_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Handler inputs / results
// ---------------------------------------------------------------------------

export interface AgentSpawnInput {
  /** Validated further by `config.validateSpawnArgs` (0001:T6.1 spawnSchema). */
  args?: JsonValue;
  /** Parent entity url (0001:D2: spawn carries the parent's key). */
  parentRef?: string | null;
  /** Workspace key `<tenant>/<name>` (0001:D4: chosen at spawn, never switched). */
  workspaceRef?: string;
  /** Initial subscriber entity urls (management beyond spawn is 0001:T2.3). */
  subscribers?: string[];
}

/**
 * The `message` wake payload. Discriminated: plain messages, plus the two
 * platform-typed deliveries the stub notifier (and later 0001:T2.3) produces.
 */
export type AgentMessageInput =
  | {
      kind?: "message";
      content: ContentBlock[];
      /** Sender entity url, for inter-agent messages. */
      from?: string;
      /** Wake source override (cron deliveries, steer degradation, …). */
      source?: Extract<WakeSource, "message" | "steer_degraded" | "cron" | "system">;
    }
  | {
      kind: "child_finished";
      childId: string;
      outcome: ChildFinishedNotification["outcome"];
      result?: JsonValue;
    }
  | {
      kind: "subscription_update";
      entityId: string;
      headSeq: number | null;
      status: EntityStatus;
    };

export interface AgentSignalInput {
  verb: ControlVerb;
  reason?: string;
  /** Requesting principal/entity, when known. */
  from?: string;
}

export type AgentSignalResult =
  | { delivered: true; verb: "interrupt"; cancelledInvocationId: string }
  | { delivered: false; verb: ControlVerb; reason: "idle" | "unsupported" };

export interface ArchiveTickMessage {
  /** The `archiveEpoch` this tick was minted under (generation guard). */
  epoch: number;
}

export interface SubscribeInput {
  /** Entity url that wants `subscription_update` notifications from this entity. */
  subscriberRef: string;
}

export type ArchiveTickResult =
  | { archived: true; snapshotSeq: number }
  | { archived: false; reason: "stale-epoch" | "not-idle" | "paused" };

export interface WakeResult {
  entityId: string;
  /** Head seq after this wake (last event confirmed to the outbox). */
  headSeq: number | null;
  /**
   * The run outcome — present for a wake that actually ran. `undefined` when
   * the wake was `queued` (the entity was paused, 0001:T2.5): no harness ran and no
   * events were recorded; `resume` re-enqueues the held input.
   */
  outcome?: RunOutcome;
  /** True when this wake was queued (entity paused, 0001:T2.5) rather than run. */
  queued?: true;
}

export interface SpawnResult {
  /** False on idempotent reattach (addressing §3.3) — no re-init, no events. */
  created: boolean;
  entityId: string;
  headSeq: number | null;
  outcome?: RunOutcome;
}

// ---------------------------------------------------------------------------
// onWake contract (0001:T6.1 `defineAgent.onWake`, loop-wired in 0001:T8.1)
// ---------------------------------------------------------------------------

/**
 * The seam an `onWake` handler acts through. All I/O is journaled (0001:D2: no naked
 * clock/random; use `now()`), so an onWake handler is deterministic across
 * Restate retries — the same rule the harnesses follow. Runs after the wake
 * input is in `context` and before the harness.
 */
export interface OnWakeContext {
  /** The live wake runtime ctx (for `ctx.run` journaling in developer code). */
  ctx: AgentRuntimeCtx;
  /** This entity's url. */
  entityId: string;
  /** Deterministic run id (stable across retries of this invocation). */
  runId: string;
  /** What woke the entity. */
  wakeSource: WakeSource;
  /** Sender entity url, when the wake carried one. */
  wakeFrom?: string;
  /** The bounded canonical context (K/V) as of wake start, wake input included. */
  canonicalContext: readonly TimelineEvent[];
  /** Journaled clock read (replay-stable) — use instead of `Date.now()`. */
  now(): Promise<number>;
  /**
   * Emit canonical events onto THIS entity's timeline through the outbox (the
   * sole seq allocator, 0001:A1). Returns the finalized events (with seqs). Folded
   * into the bounded context after onWake returns.
   */
  emit(events: readonly TimelineEventInit[]): Promise<TimelineEvent[]>;
  /** Fire-and-forget one-way `message` send to another agent (0001:D2 / 0001:T2.3 dead-letter-free path). */
  send(targetRef: string, payload: AgentSendPayload): void;
  /** Spawn a child (0001:D2): fires the `spawn` send and emits `child_spawned` on this timeline. */
  spawn(req: Omit<SpawnChildRequest, "parentRef" | "runId">): Promise<TimelineEvent>;
}

/**
 * What an `onWake` handler returns. `{ handled: true }` ⇒ the wake is fully
 * handled deterministically and the LLM harness does NOT run (`outcome`
 * defaults to `success`). Falsy / `{ handled: false }` ⇒ HAND OFF to the
 * harness (onWake's emitted events already precede the harness's). This is the
 * onWake-only vs onWake-then-harness contract (PLAN 0001:T8.1 / 0001:T6.3).
 */
export type OnWakeOutcome = { handled: true; outcome?: RunOutcome } | { handled?: false } | void;

export type OnWakeHandler = (wake: OnWakeContext) => OnWakeOutcome | Promise<OnWakeOutcome>;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();

function resolved(config: AgentObjectConfig) {
  return {
    tenant: config.tenant ?? "default",
    metrics: config.metrics ?? NOOP_COORDINATION_METRICS,
    steerSource: config.steerSource ?? emptySteerSource,
    emitDelta: config.emitDelta ?? noopEmitDelta,
    tools: config.tools ?? [],
    idleArchiveDelayMs: config.idleArchiveDelayMs ?? DEFAULT_IDLE_ARCHIVE_DELAY_MS,
    outboxChunkSize: config.outboxChunkSize ?? DEFAULT_OUTBOX_CHUNK_SIZE,
    contextOpaqueOrigins: config.contextOpaqueOrigins ?? [config.harness.kind],
    subscriberNotifyDebounceMs:
      config.subscriberNotifyDebounceMs ?? DEFAULT_SUBSCRIBER_NOTIFY_DEBOUNCE_MS,
  };
}

/**
 * Merge freshly committed events into the bounded K/V context (0001:D1): keep
 * context-bearing events (+ owning-harness opaques), apply the
 * summarization fold — which is the bounding mechanism — via the shared
 * normative selector (0001:T3.1 `selectContextEvents`).
 */
async function updateContextKv(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  committed: readonly TimelineEvent[],
): Promise<void> {
  if (committed.length === 0) return;
  const existing = (await ctx.get<TimelineEvent[]>(AGENT_KV.context)) ?? [];
  const next = selectContextEvents([...existing, ...committed], {
    includeOpaqueOrigins: resolved(config).contextOpaqueOrigins,
  });
  ctx.set(AGENT_KV.context, next);
}

export async function scheduleArchiveTick(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
): Promise<void> {
  // Bump the epoch on EVERY wake — this invalidates any previously queued
  // tick (cron.ts generation-guard pattern; queued delayed sends cannot be
  // individually revoked).
  const epoch = ((await ctx.get<number>(AGENT_KV.archiveEpoch)) ?? 0) + 1;
  ctx.set(AGENT_KV.archiveEpoch, epoch);
  const delay = resolved(config).idleArchiveDelayMs;
  if (delay <= 0) return; // archive timer disabled
  ctx.genericSend({
    service: agentServiceName(config.entityType),
    method: "archiveTick",
    key: ctx.key,
    parameter: { epoch } satisfies ArchiveTickMessage,
    delay,
  });
}

interface WakeSpec {
  /** Events recording the wake input — committed (with seq) BEFORE the harness runs. */
  preEvents: TimelineEventInit[];
  wake: { source: WakeSource; from?: string };
  /** When set, a `child_finished` notification is sent here after the wake completes (spawn wake only for now — see runWake note). */
  notifyParentRef?: string | null;
}

/**
 * 0001:T8.2 span + metrics wrapper around the wake pipeline. Opens ONE `agent.wake`
 * span per invocation (parented under the caller's context extracted from the
 * wake envelope, so gateway → agent linkage holds), tagged
 * entity/type/wake.source/runId, and records the `wakes_per_sec` counter. The
 * span is a no-op unless a tracer provider is registered (gateway `otel.ts`
 * pattern), so this is free on the default stack and invisible to the fakes.
 */
async function runWake(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  entityId: string,
  spec: WakeSpec,
): Promise<WakeResult> {
  const tracer = getTracer();
  const parent = ctx.otelContext ?? otelContext.active();
  return tracer.startActiveSpan(
    "agent.wake",
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        "teaspill.entity.id": entityId,
        "teaspill.entity.type": config.entityType,
        "wake.source": spec.wake.source,
        "teaspill.run.id": ctx.invocationId,
        ...(spec.wake.from !== undefined && { "wake.from": spec.wake.from }),
      },
    },
    parent,
    async (span) => {
      try {
        const result = await runWakeInner(ctx, config, entityId, spec);
        span.setAttribute("run.outcome", result.outcome ?? (result.queued ? "queued" : "unknown"));
        if (!result.queued) {
          resolved(config).metrics.recordWake({
            entityType: config.entityType,
            wakeSource: spec.wake.source,
            ...(result.outcome !== undefined && { outcome: result.outcome }),
          });
        }
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * The shared wake pipeline: flush leftovers → record wake input +
 * run_started → harness (raced against interrupt) → commit events +
 * run_finished in bounded chunks → update context/usage K/V → notify →
 * re-arm archive timer.
 */
async function runWakeInner(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  entityId: string,
  spec: WakeSpec,
): Promise<WakeResult> {
  const r = resolved(config);
  let outcome: RunOutcome;
  // Structured result a step-durable harness surfaced via a `finish` control
  // tool (0001:T3.3 / gap d) — forwarded to the parent's `child_finished` note.
  let finishResult: JsonValue | undefined;

  // The interrupt target (0001:A4): shared `signal` reads this live (SPIKE §a-2/3).
  ctx.set(AGENT_KV.currentInvocationId, ctx.invocationId);
  ctx.set<EntityStatus>(AGENT_KV.status, "active");
  try {
    // 0001:D3: retry any outbox left over from a previous crashed wake FIRST, so
    // stream order is preserved before new seqs pile up behind it.
    await config.outbox.flush(ctx, entityId);

    // 0001:T2.6 no-loss contract (the wire-in steer.ts left for whoever next
    // touches agent.ts): unconditionally drain the steerbox at wake start so a
    // steer that landed in the idle gap becomes the first input of this wake.
    // Journaled (`ctx.run`) because the real `SteerSource` does I/O (0001:D2).
    const steered = await ctx.run("steer-drain", () => drainAtWakeStart(r.steerSource));
    const preEvents = [...steered, ...spec.preEvents];

    const startedAt = await ctx.run("now", () => Date.now());
    const runId = ctx.invocationId; // replay-stable across attempts of this invocation

    if (config.onWake) {
      // 0001:T8.1 onWake path (deterministic per-wake logic; onWake-only OR
      // onWake-then-harness). Authors its own run boundaries around the hook.
      const onWakeResult = await runOnWakeWake(ctx, config, entityId, spec, {
        preEvents,
        startedAt,
        runId,
        resolved: r,
      });
      outcome = onWakeResult.outcome;
      finishResult = onWakeResult.finishResult;
    } else if (config.buildHarness) {
      // 0001:T6.1 STEP-DURABLE PATH (the 0001:G8 run-boundary resolution): the harness
      // journals its OWN steps and authors its OWN run_started/run_finished, so
      // we do NOT wrap it in a `ctx.run` and do NOT author boundaries here.
      const stepResult = await runStepDurableWake(ctx, config, entityId, spec, {
        preEvents,
        runId,
        resolved: r,
      });
      outcome = stepResult.outcome;
      finishResult = stepResult.finishResult;
    } else {
      // 0001:T2.1 STATIC PATH: one `ctx.run` around the whole (stub/non-durable)
      // harness, boundaries authored here, raced against interrupt per 0001:A4.
      const runStarted: TimelineEventInit = {
        type: "run_started",
        ts: iso(startedAt),
        payload: {
          runId,
          wake: {
            source: spec.wake.source,
            ...(spec.wake.from !== undefined && { from: spec.wake.from }),
          },
          // The frozen schema enumerates the two real harnesses; anything else
          // (the 0001:T2.1 stub) records as the native slot it stands in for.
          harness: config.harness.kind === "casdk" ? "casdk" : "native",
        },
      };
      const head = await commitEventsChunked(
        ctx,
        config.outbox,
        entityId,
        [...preEvents, runStarted],
        r.outboxChunkSize,
      );
      await updateContextKv(ctx, config, head);

      const canonicalContext = (await ctx.get<TimelineEvent[]>(AGENT_KV.context)) ?? [];
      try {
        const result = await getTracer().startActiveSpan(
          "harness.run",
          { attributes: { "harness.kind": config.harness.kind } },
          async (hspan) => {
            try {
              return await ctx.raceInterrupt(
                ctx.run("harness-run", () =>
                  config.harness.run({
                    entityId,
                    runId,
                    canonicalContext,
                    wakeMessage: null, // wake input is already IN the context (see module header)
                    tools: r.tools,
                    steerSource: r.steerSource,
                    signal: ctx.runAbortSignal,
                    emitDelta: r.emitDelta,
                  }),
                ),
              );
            } catch (err) {
              hspan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
              throw err;
            } finally {
              hspan.end();
            }
          },
        );
        r.metrics.recordTokenSpend(result.usage, {
          entityType: config.entityType,
          wakeSource: spec.wake.source,
        });

        const endedAt = await ctx.run("now", () => Date.now());
        const runFinished: TimelineEventInit = {
          type: "run_finished",
          ts: iso(endedAt),
          payload: {
            runId,
            outcome: "success",
            usage: result.usage,
            durationMs: Math.max(0, endedAt - startedAt),
          },
        };
        const committed = await commitEventsChunked(
          ctx,
          config.outbox,
          entityId,
          [...result.events, runFinished],
          r.outboxChunkSize,
        );
        await updateContextKv(ctx, config, committed);

        const usage = accumulateUsage(await ctx.get<RunUsage>(AGENT_KV.usage), result.usage);
        if (result.stateDelta.contextTokens !== undefined) {
          usage.contextTokens = result.stateDelta.contextTokens;
        }
        ctx.set(AGENT_KV.usage, usage);
        if (result.stateDelta.harness !== undefined) {
          if (result.stateDelta.harness === null) ctx.clear(AGENT_KV.harness);
          else ctx.set(AGENT_KV.harness, result.stateDelta.harness);
        }
        outcome = "success";
      } catch (err) {
        if (err instanceof AgentInterruptedError) {
          // explicitCancellation (0001:A4): durable steps still work here. Record
          // the control event + run_finished(interrupted), flush, stay live.
          const now = await ctx.run("now-interrupted", () => Date.now());
          const committed = await commitEventsChunked(
            ctx,
            config.outbox,
            entityId,
            [
              {
                type: "control",
                ts: iso(now),
                payload: { verb: "interrupt" },
              },
              {
                type: "run_finished",
                ts: iso(now),
                payload: { runId, outcome: "interrupted", usage: ZERO_RUN_USAGE },
              },
            ],
            r.outboxChunkSize,
          );
          await updateContextKv(ctx, config, committed);
          outcome = "interrupted";
        } else if (err instanceof restate.TerminalError) {
          // Run-level terminal failure the harness could not convert into an
          // error event (0001:D5): record it, keep the entity consistent and live.
          const now = await ctx.run("now-error", () => Date.now());
          const committed = await commitEventsChunked(
            ctx,
            config.outbox,
            entityId,
            [
              {
                type: "error",
                ts: iso(now),
                payload: { runId, message: err.message, source: "harness" },
              },
              {
                type: "run_finished",
                ts: iso(now),
                payload: { runId, outcome: "error", usage: ZERO_RUN_USAGE },
              },
            ],
            r.outboxChunkSize,
          );
          await updateContextKv(ctx, config, committed);
          outcome = "error";
        } else {
          // Transient — rethrow so Restate retries the invocation; the outbox
          // holds anything staged-but-unflushed and replays in order (0001:D3).
          throw err;
        }
      }
    }
  } finally {
    ctx.clear(AGENT_KV.currentInvocationId);
  }

  ctx.set<EntityStatus>(AGENT_KV.status, "idle");

  // Notify seam (0001:T2.3). child_finished back-send first: with a directory it is
  // dead-letter-checked (a gone/archived parent stages an `error` on THIS
  // timeline, 0001:D2 "never silent") — which appends events, so head_seq is read
  // AFTER it. Without a directory it stays best-effort fire-and-forget (0001:T2.1).
  if (spec.notifyParentRef) {
    const note: ChildFinishedNotification = {
      childId: entityId,
      outcome: outcome === "success" ? "success" : outcome,
      ...(finishResult !== undefined && { result: finishResult }),
    };
    if (config.directory) {
      await notifyParentOrDeadLetter(ctx, {
        outbox: config.outbox,
        directory: config.directory,
        notifier: config.notifier,
        childId: entityId,
        parentRef: spec.notifyParentRef,
        note,
      });
    } else {
      config.notifier.notifyParent(ctx, spec.notifyParentRef, note);
    }
  }

  const headSeq = headSeqOf(await ctx.get<number>(AGENT_KV.seq));

  // Subscriber pub/sub (0001:D2): debounced via a coalescing `notifyTick` self-send
  // (delayed + dirty flag + generation guard) when configured, else inline.
  const subscribers = (await ctx.get<string[]>(AGENT_KV.subscribers)) ?? [];
  if (subscribers.length > 0) {
    if (r.subscriberNotifyDebounceMs > 0) {
      await scheduleSubscriberNotify(ctx, {
        service: agentServiceName(config.entityType),
        debounceMs: r.subscriberNotifyDebounceMs,
      });
    } else {
      config.notifier.notifySubscribers(ctx, subscribers, { entityId, headSeq, status: "idle" });
    }
  }

  await scheduleArchiveTick(ctx, config);
  return { entityId, headSeq, outcome };
}

interface StepDurableWakeInternals {
  preEvents: TimelineEventInit[];
  runId: string;
  resolved: ReturnType<typeof resolved>;
}

interface StepDurableWakeResult {
  outcome: RunOutcome;
  finishResult?: JsonValue;
}

/**
 * The 0001:T6.1 step-durable wake body (the 0001:G8 run-boundary resolution). Unlike the
 * static path it does NOT wrap the harness in a `ctx.run` and does NOT author
 * `run_started`/`run_finished` — the harness (compiled native/pi, 0001:T3.2) journals
 * its own steps and authors its own boundaries via the `commitEvents` seam.
 *
 * Flow: commit the handler's pre-events (wake input, WITHOUT run_started) →
 * update context → build the harness for THIS wake (`config.buildHarness`,
 * threading the true `wakeSource`/`wakeFrom` [gap b] and prior `contextTokens`
 * [gap c]) → arm interrupt→abort (non-throwing; the harness winds itself down)
 * → run, committing at every step boundary → fold in returned tail events +
 * usage/state deltas. A `finish` control tool's result (surfaced by the harness
 * in the committed `run_finished.detail.control`, gap d) is captured for the
 * parent's `child_finished` note.
 */
async function runStepDurableWake(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  entityId: string,
  spec: WakeSpec,
  internals: StepDurableWakeInternals,
): Promise<StepDurableWakeResult> {
  const { preEvents, runId, resolved: r } = internals;
  const buildHarness = config.buildHarness!;

  // 1. Commit the pre-events (wake input) BEFORE the harness authors run_started.
  const committedAll: TimelineEvent[] = [];
  let finishResult: JsonValue | undefined;
  const captureControl = (events: readonly TimelineEvent[]): void => {
    for (const ev of events) {
      if (ev.type !== "run_finished") continue;
      const detail = (ev.payload as { detail?: { control?: { kind?: string; result?: JsonValue } } })
        .detail;
      if (detail?.control?.kind === "finish") finishResult = detail.control.result;
    }
  };

  if (preEvents.length > 0) {
    // Pre-events are folded into context here; they are NOT accumulated into
    // `committedAll` (which drives the post-run context update) so the final
    // fold merges the ALREADY-committed pre-context with only the strictly-later
    // harness events — keeping the seq order ascending.
    const pre = await commitEventsChunked(ctx, config.outbox, entityId, preEvents, r.outboxChunkSize);
    await updateContextKv(ctx, config, pre);
  }

  const canonicalContext = (await ctx.get<TimelineEvent[]>(AGENT_KV.context)) ?? [];
  const priorUsage = await ctx.get<RunUsage>(AGENT_KV.usage);

  // 2. Step-boundary commit seam (0001:D5): stage+flush through the outbox (the seq
  //    allocator, 0001:A1), capture any surfaced finish result (gap d).
  const commitEvents = async (
    events: readonly TimelineEventInit[],
  ): Promise<readonly TimelineEvent[]> => {
    if (events.length === 0) return [];
    const committed = await commitEventsChunked(
      ctx,
      config.outbox,
      entityId,
      events,
      r.outboxChunkSize,
    );
    committedAll.push(...committed);
    captureControl(committed);
    // Return the finalized (seq-bearing) events so a step-durable harness can
    // advance its summarization fold boundary (0002:T3.2). The seam is
    // fire-and-forget for callers that ignore it (the pre-0002 shape).
    return committed;
  };

  // 3. Build the harness for THIS wake (needs the live ctx as its HarnessCtx +
  //    ingress-client root), threading gap-b source and gap-c budget seed.
  const harness = buildHarness({
    ctx,
    entityId,
    runId,
    wakeSource: spec.wake.source,
    ...(spec.wake.from !== undefined && { wakeFrom: spec.wake.from }),
    ...(priorUsage?.contextTokens !== undefined && { priorContextTokens: priorUsage.contextTokens }),
  });

  // 4. Arm interrupt→abort without throwing — the harness treats abort as a
  //    normal outcome and authors its own run_finished(interrupted).
  ctx.armInterruptAbort?.();

  let result;
  try {
    result = await getTracer().startActiveSpan(
      "harness.run",
      { attributes: { "harness.kind": config.harness.kind, "harness.stepDurable": true } },
      async (hspan) => {
        try {
          return await harness.run({
            entityId,
            runId,
            canonicalContext,
            wakeMessage: null, // pre-commit convention retained (module header)
            tools: r.tools,
            steerSource: r.steerSource,
            signal: ctx.runAbortSignal,
            emitDelta: r.emitDelta,
            commitEvents,
          });
        } catch (err) {
          hspan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          hspan.end();
        }
      },
    );
  } catch (err) {
    if (err instanceof restate.TerminalError) {
      // A run-level failure the step-durable harness could not convert into an
      // error event (rare — most terminal failures are journaled as provider
      // errors by the harness itself). Author the balancing terminal events.
      const now = await ctx.run("now-error", () => Date.now());
      await commitEvents([
        { type: "error", ts: iso(now), payload: { runId, message: err.message, source: "harness" } },
        {
          type: "run_finished",
          ts: iso(now),
          payload: { runId, outcome: "error", usage: ZERO_RUN_USAGE },
        },
      ]);
      await updateContextKv(ctx, config, committedAll);
      return { outcome: "error", ...(finishResult !== undefined && { finishResult }) };
    }
    // Transient — rethrow so Restate retries; the outbox replays in order (0001:D3).
    throw err;
  }

  // 5. Commit any returned tail (a harness using `commitEvents` returns []), and
  //    fold everything committed this wake into the bounded context.
  if (result.events.length > 0) {
    await commitEvents(result.events);
  }
  await updateContextKv(ctx, config, committedAll);

  r.metrics.recordTokenSpend(result.usage, {
    entityType: config.entityType,
    wakeSource: spec.wake.source,
  });

  // 6. Usage + harness continuation state (same discipline as the static path).
  const usage = accumulateUsage(priorUsage, result.usage);
  if (result.stateDelta.contextTokens !== undefined) {
    usage.contextTokens = result.stateDelta.contextTokens;
  }
  ctx.set(AGENT_KV.usage, usage);
  if (result.stateDelta.harness !== undefined) {
    if (result.stateDelta.harness === null) ctx.clear(AGENT_KV.harness);
    else ctx.set(AGENT_KV.harness, result.stateDelta.harness);
  }

  // The harness authored run_finished with the true outcome; derive the return
  // outcome (interrupt wins — the harness wound down on abort).
  const outcome: RunOutcome = ctx.runAbortSignal.aborted ? "interrupted" : "success";
  return { outcome, ...(finishResult !== undefined && { finishResult }) };
}

/**
 * The 0001:T8.1 onWake wake body. Brackets a deterministic `config.onWake` hook in
 * `run_started`/`run_finished` (authored here — onWake is not step-durable) and
 * lets the developer's hook either HANDLE the wake fully (onWake-only ⇒ no LLM)
 * or HAND OFF to the static `config.harness` (onWake-then-harness). onWake's
 * emitted events land after `run_started` and before any harness output, so the
 * timeline reads: wake input → run_started → onWake events → [harness events] →
 * run_finished.
 *
 * Contract note: onWake handoff runs the STATIC `config.harness` (raced against
 * interrupt, 0001:A4), regardless of `buildHarness` — combining onWake with a
 * step-durable harness is out of scope for v1 (deterministic agents use a stub
 * harness). Interrupt/terminal-error handling mirrors the static path.
 */
async function runOnWakeWake(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  entityId: string,
  spec: WakeSpec,
  internals: { preEvents: TimelineEventInit[]; startedAt: number; runId: string; resolved: ReturnType<typeof resolved> },
): Promise<StepDurableWakeResult> {
  const { preEvents, startedAt, runId, resolved: r } = internals;
  const onWake = config.onWake!;

  // 1. Commit wake input + run_started (authored here), fold into context.
  const runStarted: TimelineEventInit = {
    type: "run_started",
    ts: iso(startedAt),
    payload: {
      runId,
      wake: { source: spec.wake.source, ...(spec.wake.from !== undefined && { from: spec.wake.from }) },
      harness: config.harness.kind === "casdk" ? "casdk" : "native",
    },
  };
  const head = await commitEventsChunked(
    ctx,
    config.outbox,
    entityId,
    [...preEvents, runStarted],
    r.outboxChunkSize,
  );
  await updateContextKv(ctx, config, head);

  const canonicalContext = (await ctx.get<TimelineEvent[]>(AGENT_KV.context)) ?? [];
  const emittedByOnWake: TimelineEvent[] = [];
  const emit = async (events: readonly TimelineEventInit[]): Promise<TimelineEvent[]> => {
    if (events.length === 0) return [];
    const committed = await commitEventsChunked(ctx, config.outbox, entityId, events, r.outboxChunkSize);
    emittedByOnWake.push(...committed);
    return committed;
  };
  const onWakeCtx: OnWakeContext = {
    ctx,
    entityId,
    runId,
    wakeSource: spec.wake.source,
    ...(spec.wake.from !== undefined && { wakeFrom: spec.wake.from }),
    canonicalContext,
    now: () => ctx.run("on-wake-now", () => Date.now()),
    emit,
    send: (targetRef, payload) => config.notifier.send(ctx, targetRef, payload),
    spawn: async (req) => {
      const init = await spawnChild(ctx, { ...req, parentRef: entityId, runId });
      const [ev] = await emit([init]);
      return ev!;
    },
  };

  // 2. Run the deterministic hook.
  const decision = (await onWake(onWakeCtx)) ?? undefined;
  const handled = decision !== undefined && decision !== null && "handled" in decision && decision.handled === true;

  // onWake never surfaces a `finish`-tool result (that is a harness concept),
  // so this path returns no `finishResult`.
  let outcome: RunOutcome;

  if (handled) {
    // onWake-only: the wake is fully handled; no harness runs.
    outcome = (decision as { handled: true; outcome?: RunOutcome }).outcome ?? "success";
    await updateContextKv(ctx, config, emittedByOnWake);
  } else {
    // onWake-then-harness: hand off to the static harness.
    const canonical2 = (await ctx.get<TimelineEvent[]>(AGENT_KV.context)) ?? [];
    try {
      const result = await ctx.raceInterrupt(
        ctx.run("harness-run", () =>
          config.harness.run({
            entityId,
            runId,
            canonicalContext: canonical2,
            wakeMessage: null,
            tools: r.tools,
            steerSource: r.steerSource,
            signal: ctx.runAbortSignal,
            emitDelta: r.emitDelta,
          }),
        ),
      );
      r.metrics.recordTokenSpend(result.usage, {
        entityType: config.entityType,
        wakeSource: spec.wake.source,
      });
      const endedAt = await ctx.run("now", () => Date.now());
      const runFinished: TimelineEventInit = {
        type: "run_finished",
        ts: iso(endedAt),
        payload: {
          runId,
          outcome: "success",
          usage: result.usage,
          durationMs: Math.max(0, endedAt - startedAt),
        },
      };
      const committed = await commitEventsChunked(
        ctx,
        config.outbox,
        entityId,
        [...result.events, runFinished],
        r.outboxChunkSize,
      );
      await updateContextKv(ctx, config, [...emittedByOnWake, ...committed]);
      const usage = accumulateUsage(await ctx.get<RunUsage>(AGENT_KV.usage), result.usage);
      if (result.stateDelta.contextTokens !== undefined) usage.contextTokens = result.stateDelta.contextTokens;
      ctx.set(AGENT_KV.usage, usage);
      if (result.stateDelta.harness !== undefined) {
        if (result.stateDelta.harness === null) ctx.clear(AGENT_KV.harness);
        else ctx.set(AGENT_KV.harness, result.stateDelta.harness);
      }
      return { outcome: "success" };
    } catch (err) {
      if (err instanceof AgentInterruptedError) {
        const now = await ctx.run("now-interrupted", () => Date.now());
        await commitEventsChunked(
          ctx,
          config.outbox,
          entityId,
          [
            { type: "control", ts: iso(now), payload: { verb: "interrupt" } },
            { type: "run_finished", ts: iso(now), payload: { runId, outcome: "interrupted", usage: ZERO_RUN_USAGE } },
          ],
          r.outboxChunkSize,
        );
        outcome = "interrupted";
      } else if (err instanceof restate.TerminalError) {
        const now = await ctx.run("now-error", () => Date.now());
        await commitEventsChunked(
          ctx,
          config.outbox,
          entityId,
          [
            { type: "error", ts: iso(now), payload: { runId, message: err.message, source: "harness" } },
            { type: "run_finished", ts: iso(now), payload: { runId, outcome: "error", usage: ZERO_RUN_USAGE } },
          ],
          r.outboxChunkSize,
        );
        outcome = "error";
      } else {
        throw err;
      }
      await updateContextKv(ctx, config, (await ctx.get<TimelineEvent[]>(AGENT_KV.context)) ?? []);
      return { outcome };
    }
  }

  // onWake-only tail: author run_finished with the handled outcome.
  const endedAt = await ctx.run("now", () => Date.now());
  const runFinished: TimelineEventInit = {
    type: "run_finished",
    ts: iso(endedAt),
    payload: { runId, outcome, usage: ZERO_RUN_USAGE, durationMs: Math.max(0, endedAt - startedAt) },
  };
  const committed = await commitEventsChunked(ctx, config.outbox, entityId, [runFinished], r.outboxChunkSize);
  await updateContextKv(ctx, config, committed);
  return { outcome };
}

// ---------------------------------------------------------------------------
// Handlers (logic — unit-testable against fakes; see agent.test.ts)
// ---------------------------------------------------------------------------

/**
 * First wake. Writes `entity_spawned` at seq 0 through the outbox (0001:A1: the
 * first event of every entity), initializes the full K/V layout, renders the
 * spawn args as the wake input, and runs the harness. Re-spawn on an
 * existing key = idempotent no-op reattach (deterministic spawn,
 * addressing §3.3) — Restate is the arbiter, not the catalog.
 */
export async function handleSpawn(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  input: AgentSpawnInput,
): Promise<SpawnResult> {
  const r = resolved(config);
  const entityId = agentEntityUrl(r.tenant, config.entityType, ctx.key);

  const existingSeq = await ctx.get<number>(AGENT_KV.seq);
  if (existingSeq !== null) {
    // Reattach. NOTE (open question for 0001:T6.1): detecting materially
    // different re-spawn args (addressing §3.3 wants an `error` event then)
    // requires retaining the original args for comparison — deferred to
    // defineAgent, which owns the spawn schema.
    return { created: false, entityId, headSeq: headSeqOf(existingSeq) };
  }

  // 0001:D7 RESURRECTION on spawn (0001:T8.1): a spawn targeting an archived-and-cleared
  // key must NOT re-initialize over the existing timeline (that would collide
  // on seq 0). Rehydrate from the catalog snapshot and reattach (created:false,
  // no wake — mirrors the existing-seq reattach; a message wakes it). Only a
  // genuinely new key falls through to fresh init below.
  if (await resurrectFromCatalog(ctx, config, entityId)) {
    ctx.set<EntityStatus>(AGENT_KV.status, "idle"); // reattach: no wake runs
    await scheduleArchiveTick(ctx, config); // re-arm the idle timer
    const seqNow = await ctx.get<number>(AGENT_KV.seq);
    return { created: false, entityId, headSeq: headSeqOf(seqNow) };
  }

  const args = config.validateSpawnArgs ? config.validateSpawnArgs(input.args) : input.args;
  const parentRef = input.parentRef ?? null;

  // Initialize the K/V layout (documented at AGENT_KV).
  ctx.set(AGENT_KV.parentRef, parentRef);
  if (input.workspaceRef !== undefined) ctx.set(AGENT_KV.workspaceRef, input.workspaceRef);
  ctx.set(AGENT_KV.subscribers, input.subscribers ?? []);
  ctx.set(AGENT_KV.usage, ZERO_RUN_USAGE);
  ctx.set(AGENT_KV.context, []);

  const now = await ctx.run("now-spawn", () => Date.now());
  const preEvents: TimelineEventInit[] = [
    {
      type: "entity_spawned",
      ts: iso(now),
      payload: {
        entityType: config.entityType,
        parentId: parentRef,
        ...(args !== undefined && { spawnArgs: args }),
        ...(input.workspaceRef !== undefined && { workspaceRef: input.workspaceRef }),
      },
    },
  ];
  if (args !== undefined) {
    // Render spawn args as the wake input so the harness sees them in
    // context (entity_spawned itself is not context-bearing). 0001:T6.1's
    // defineAgent owns richer rendering.
    preEvents.push({
      type: "message",
      ts: iso(now),
      payload: {
        id: `spawn-${ctx.invocationId}`,
        role: "user",
        content: [{ type: "text", text: JSON.stringify(args) }],
        ...(parentRef !== null && { from: parentRef }),
      },
    });
  }

  const result = await runWake(ctx, config, entityId, {
    preEvents,
    wake: { source: "spawn", ...(parentRef !== null && { from: parentRef }) },
    notifyParentRef: parentRef,
  });
  // A spawn wake always runs (it is the first wake — never pausable/queued),
  // so `result.outcome` is always defined here.
  return {
    created: true,
    entityId,
    headSeq: result.headSeq,
    ...(result.outcome !== undefined && { outcome: result.outcome }),
  };
}

/**
 * 0001:D7 RESURRECTION (0001:T8.1): rehydrate an archived-and-cleared entity from the
 * catalog `archived_snapshot` (never the stream, 0001:D1/0001:D7) so the wake can proceed.
 *
 * **Race-safety (PLAN 0001:T8.1 anticipate):** this runs INSIDE the exclusive
 * `message` handler, so single-writer serialization makes it safe against a
 * second concurrent message — Restate queues the two invocations; the FIRST
 * sees `seq === null`, loads the snapshot (journaled via `ctx.run` in the seam,
 * so replay-stable), and rebuilds live K/V; the SECOND runs only after the
 * first COMMITS and therefore sees live state (`seq !== null`) and skips
 * resurrection entirely. No lock, no double-rehydrate.
 *
 * The seq counter CONTINUES from `head_seq` (0001:A5: `archived` is episode-terminal,
 * not seq-terminal) — the next allocated seq is `head_seq + 1`, and
 * `outboxConfirmedSeq` is reconstructed as `head_seq` so the next flush appends
 * at producer seq `head_seq + 1` (epoch unchanged at 0 — archive never bumps
 * it), which the durable-streams producer accepts as `last + 1`.
 *
 * Returns `true` when it resurrected, `false` when there is no archived snapshot
 * to resurrect from (never spawned / no catalog seam) — the caller then fails.
 */
export async function resurrectFromCatalog(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  entityId: string,
): Promise<boolean> {
  if (!config.archiveCatalog) return false;
  const row = await config.archiveCatalog.loadArchivedSnapshot(ctx, entityId);
  if (row === null) return false;
  if (row.headSeq === null) {
    // Archived row with a snapshot but no head_seq is corruption (archive
    // always commits events ⇒ head_seq is set). Fail loudly rather than
    // resurrecting at an unknowable seq.
    throw new restate.TerminalError(
      `agent ${entityId} archived_snapshot has null head_seq — cannot continue the seq counter (corrupt archive)`,
    );
  }
  const snapshot = row.snapshot as unknown as ArchiveSnapshotState;

  // Rebuild the live K/V from the bounded snapshot (0001:D1). Continue seq from
  // head_seq (0001:A5): next unallocated = head_seq + 1.
  ctx.set(AGENT_KV.status, "active");
  ctx.set(AGENT_KV.seq, row.headSeq + 1);
  ctx.set(AGENT_KV.context, snapshot.context ?? []);
  ctx.set(AGENT_KV.usage, snapshot.usage ?? ZERO_RUN_USAGE);
  ctx.set(AGENT_KV.subscribers, snapshot.subscribers ?? []);
  ctx.set(AGENT_KV.parentRef, snapshot.parentRef ?? null);
  if (snapshot.workspaceRef != null) ctx.set(AGENT_KV.workspaceRef, snapshot.workspaceRef);
  if (snapshot.harness != null) ctx.set(AGENT_KV.harness, snapshot.harness);
  ctx.set(AGENT_KV.outbox, []);
  // The stream already holds seq ≤ head_seq (the terminal `archived` event was
  // confirmed before K/V was cleared); mark it confirmed so the next flush
  // appends at head_seq + 1 in order, at the SAME producer epoch/offset the
  // entity archived with (0001:A9 / 0002:T2.1): 0/0 in normal operation (the
  // identity), the post-reset values for an entity that underwent a
  // catastrophic epoch reset — resurrecting those at epoch 0 would be fenced.
  ctx.set(OUTBOX_KV.confirmedSeq, row.headSeq);
  ctx.set(OUTBOX_KV.producerEpoch, snapshot.producerEpoch ?? 0);
  ctx.set(OUTBOX_KV.producerSeqOffset, snapshot.producerSeqOffset ?? 0);
  return true;
}

/** Ordinary wake. See `AgentMessageInput` for the accepted variants. */
export async function handleMessage(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  rawInput: AgentMessageInput,
): Promise<WakeResult> {
  const r = resolved(config);
  const entityId = agentEntityUrl(r.tenant, config.entityType, ctx.key);

  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    // Never spawned — or archived-and-cleared. Try RESURRECTION from the
    // catalog snapshot (0001:D7/0001:T8.1); if there is nothing to resurrect from, this
    // is a terminal, visible failure (dead-lettering onto the SENDER's timeline
    // is 0001:T2.3 — but `archived` is no longer dead-lettered now that resurrection
    // exists, see DEFAULT_DEAD_STATUSES).
    const resurrected = await resurrectFromCatalog(ctx, config, entityId);
    if (!resurrected) {
      throw new restate.TerminalError(
        `agent ${entityId} has no live state (not spawned, or archived with no resurrectable snapshot)`,
      );
    }
  }

  const input = config.validateMessage ? config.validateMessage(rawInput) : rawInput;

  // 0001:T2.5 pause gate (checked at invocation start): a paused entity queues the
  // wake into `pausedMailbox` without running the harness; `resume` re-enqueues.
  const queued = await queueIfPaused(ctx, entityId, input);
  if (queued) return queued;

  const now = await ctx.run("now-message", () => Date.now());

  let preEvents: TimelineEventInit[];
  let wake: WakeSpec["wake"];
  switch (input.kind) {
    case undefined:
    case "message": {
      preEvents = [
        {
          type: "message",
          ts: iso(now),
          payload: {
            id: `wake-${ctx.invocationId}`,
            role: "user",
            content: input.content,
            ...(input.from !== undefined && { from: input.from }),
          },
        },
      ];
      wake = {
        source: input.source ?? "message",
        ...(input.from !== undefined && { from: input.from }),
      };
      break;
    }
    case "child_finished": {
      const noteText =
        `[child finished] ${input.childId} → ${input.outcome}` +
        (input.result !== undefined ? `\nresult: ${JSON.stringify(input.result)}` : "");
      preEvents = [
        {
          type: "child_finished",
          ts: iso(now),
          payload: {
            childId: input.childId,
            outcome: input.outcome,
            ...(input.result !== undefined && { result: input.result }),
          },
        },
        {
          type: "message",
          ts: iso(now),
          payload: {
            id: `wake-${ctx.invocationId}`,
            role: "system_note",
            content: [{ type: "text", text: noteText }],
            from: input.childId,
          },
        },
      ];
      wake = { source: "message", from: input.childId };
      break;
    }
    case "subscription_update": {
      preEvents = [
        {
          type: "message",
          ts: iso(now),
          payload: {
            id: `wake-${ctx.invocationId}`,
            role: "system_note",
            content: [
              {
                type: "text",
                text: `[subscription] ${input.entityId} changed (head_seq ${input.headSeq ?? "none"}, status ${input.status})`,
              },
            ],
            from: input.entityId,
          },
        },
      ];
      wake = { source: "system", from: input.entityId };
      break;
    }
    default: {
      const exhaustive: never = input;
      throw new restate.TerminalError(
        `unknown message kind ${JSON.stringify((exhaustive as { kind?: string }).kind)}`,
      );
    }
  }

  return runWake(ctx, config, entityId, { preEvents, wake });
}

/**
 * SHARED control channel (0001:A4/SPIKE §a) — runs concurrently with a busy
 * exclusive wake; K/V is read-only here, so control is expressed as
 * invocation-cancel + one-way sends, never direct state writes.
 *
 * 0001:T2.1 wires the one verb the skeleton needs — `interrupt`: read the
 * in-flight `currentInvocationId` (visible live) and `ctx.cancel` it; the
 * exclusive wake's `raceInterrupt` then aborts the harness (~20 ms),
 * records `control` + `run_finished(interrupted)` durably, and the entity
 * stays immediately messageable. Idle entity → `delivered: false, "idle"`
 * (nothing to interrupt; interrupting a QUEUED wake is a 0001:T2.5 decision —
 * SPIKE §a-6 shows queued invocations cancel cleanly if wanted).
 *
 * `pause`/`resume`/`archive` return `"unsupported"` here — **0001:T2.5 builds the
 * full verb API on this exact seam** (same handler, same shared-context
 * constraints; pause/resume as status flags checked at wake start, archive
 * delegating to the 0001:T8.1 path).
 */
export async function handleSignal(
  ctx: AgentSharedRuntimeCtx,
  _config: AgentObjectConfig,
  sig: AgentSignalInput,
): Promise<AgentSignalResult> {
  if (sig.verb === "interrupt") {
    const inFlight = await ctx.get<string>(AGENT_KV.currentInvocationId);
    if (!inFlight) return { delivered: false, verb: "interrupt", reason: "idle" };
    // Cancel-of-completed is a harmless 409 server-side (SPIKE §a-3) — no
    // TOCTOU hazard between the read and the cancel.
    ctx.cancelInvocation(inFlight);
    return { delivered: true, verb: "interrupt", cancelledInvocationId: inFlight };
  }
  return { delivered: false, verb: sig.verb, reason: "unsupported" };
}

/**
 * Idle→archive check (0001:D7), self-scheduled with the cron.ts generation-guard
 * pattern: every wake bumps `archiveEpoch` and queues a delayed tick; a tick
 * whose epoch is stale (activity happened since) is a pure no-op. A live-epoch
 * tick on an idle, non-paused entity performs the archive (0001:T2.5 `applyArchive`,
 * trigger `idle`) — the same body the `archive` verb uses; resurrection stays
 * 0001:T8.1. A paused entity is NOT auto-archived (its `pausedMailbox` would be
 * lost); it archives only via the explicit verb.
 */
export async function handleArchiveTick(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  msg: ArchiveTickMessage,
): Promise<ArchiveTickResult> {
  const epoch = (await ctx.get<number>(AGENT_KV.archiveEpoch)) ?? 0;
  if (msg.epoch !== epoch) return { archived: false, reason: "stale-epoch" };
  const status = await ctx.get<EntityStatus>(AGENT_KV.status);
  if (status !== "idle") return { archived: false, reason: "not-idle" };
  if ((await ctx.get<boolean>(AGENT_KV.paused)) === true) {
    return { archived: false, reason: "paused" };
  }
  const { snapshotSeq } = await applyArchive(ctx, config, { trigger: "idle" });
  return { archived: true, snapshotSeq };
}

/**
 * Register a subscriber for this entity's `subscription_update` notifications
 * (0001:D2 pub/sub). Idempotent — re-subscribing the same url is a no-op. Requires
 * live state (subscribing to a never-spawned/archived entity is a terminal,
 * visible failure; resurrection is 0001:T8.1). Exclusive handler: it mutates the
 * K/V subscriber list, so it serializes behind any in-flight wake
 * (single-writer). It records no timeline event and does not re-arm the
 * archive timer — subscribing is not agent activity.
 */
export async function handleSubscribe(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const r = resolved(config);
  const entityId = agentEntityUrl(r.tenant, config.entityType, ctx.key);
  if (!parseEntityUrlLite(input.subscriberRef)) {
    throw new restate.TerminalError(
      `subscribe: not a canonical subscriber url: ${JSON.stringify(input.subscriberRef)}`,
    );
  }
  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    throw new restate.TerminalError(
      `subscribe: agent ${entityId} has no live state (not spawned, or archived)`,
    );
  }
  const list = (await ctx.get<string[]>(AGENT_KV.subscribers)) ?? [];
  const next = addSubscriber(list, input.subscriberRef);
  ctx.set(AGENT_KV.subscribers, next);
  return { subscribed: next.length !== list.length, count: next.length };
}

/** Remove a subscriber (0001:D2 pub/sub). Idempotent; same constraints as `subscribe`. */
export async function handleUnsubscribe(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  input: SubscribeInput,
): Promise<UnsubscribeResult> {
  const r = resolved(config);
  const entityId = agentEntityUrl(r.tenant, config.entityType, ctx.key);
  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    throw new restate.TerminalError(
      `unsubscribe: agent ${entityId} has no live state (not spawned, or archived)`,
    );
  }
  const list = (await ctx.get<string[]>(AGENT_KV.subscribers)) ?? [];
  const next = removeSubscriber(list, input.subscriberRef);
  ctx.set(AGENT_KV.subscribers, next);
  return { unsubscribed: next.length !== list.length, count: next.length };
}

/**
 * The subscriber-notify debounce tick (0001:T2.3, 0001:D2). Internal — armed only by
 * `scheduleSubscriberNotify` (a delayed self-send). Fires one coalesced
 * fan-out to all current subscribers, guarded by the generation + dirty flag
 * (cron.ts discipline); a stale/already-flushed tick is a pure no-op.
 */
export async function handleNotifyTick(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  msg: NotifyTickMessage,
): Promise<NotifyTickResult> {
  const r = resolved(config);
  const entityId = agentEntityUrl(r.tenant, config.entityType, ctx.key);
  return handleSubscriberNotifyTick(ctx, { entityId, notifier: config.notifier, msg });
}

// ---------------------------------------------------------------------------
// Restate wiring — thin adapters (no independent logic), cron.ts pattern.
// ---------------------------------------------------------------------------

function adaptExclusive(ctx: restate.ObjectContext, parentTrace?: OtelContext): AgentRuntimeCtx {
  // 0001:A4 interrupt seam (SPIKE §a recommended pattern, verbatim): the
  // cancellation promise is @experimental in SDK 1.16 — the SDK version is
  // pinned and the seam is a conformance-kit item (0001:T6.3/0001:T9.1).
  const ctxInternal = ctx as unknown as restate.internal.ContextInternal;
  const interruptAbort = new AbortController();
  const runAbortSignal = AbortSignal.any([
    interruptAbort.signal,
    ctx.request().attemptCompletedSignal,
  ]);
  return {
    key: ctx.key,
    invocationId: ctx.request().id,
    runAbortSignal,
    ...(parentTrace !== undefined && { otelContext: parentTrace }),
    get: <T>(name: string) => ctx.get<T>(name),
    set: <T>(name: string, value: T) => {
      ctx.set<T>(name, value);
    },
    clear: (name: string) => {
      ctx.clear(name);
    },
    run: <T>(name: string, action: () => T | Promise<T>) => ctx.run<T>(name, async () => action()),
    genericSend: (call) => {
      ctx.genericSend(call);
    },
    raceInterrupt: <T>(work: Promise<T>): Promise<T> => {
      const interrupted = ctxInternal.cancellation().map(() => {
        interruptAbort.abort(); // idempotent — .map may run more than once (SPIKE §a-5)
        throw new AgentInterruptedError();
      });
      return restate.RestatePromise.race([
        work as restate.RestatePromise<T>,
        interrupted as restate.RestatePromise<never>,
      ]);
    },
    armInterruptAbort: (): void => {
      // Non-throwing interrupt→abort for the step-durable path (0001:T6.1): the
      // harness owns its wind-down; we only need `runAbortSignal` to fire. The
      // `.map` result is intentionally not awaited (fire-and-forget arm).
      void ctxInternal.cancellation().map(() => {
        interruptAbort.abort(); // idempotent (SPIKE §a-5)
      });
    },
  };
}

function adaptShared(ctx: restate.ObjectSharedContext): AgentSharedRuntimeCtx {
  return {
    key: ctx.key,
    get: <T>(name: string) => ctx.get<T>(name),
    cancelInvocation: (invocationId: string) => {
      ctx.cancel(invocationId as restate.InvocationId);
    },
    genericSend: (call) => {
      ctx.genericSend(call);
    },
  };
}

/**
 * Build the `agent.<type>` virtual object from a config (the 0001:T6.1 seam —
 * `defineAgent` compiles its typed definition into exactly this call).
 *
 * `explicitCancellation: true` is MANDATORY (0001:A4): without it, post-interrupt
 * awaits all rethrow and the "interrupt leaves state consistent" contract is
 * unimplementable.
 */
export function createAgentObject(config: AgentObjectConfig) {
  const name = agentServiceName(config.entityType);
  const handlerOpts = {
    inactivityTimeout: config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
    abortTimeout: config.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
  };
  return restate.object({
    name,
    handlers: {
      spawn: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext, input: AgentSpawnInput): Promise<SpawnResult> => {
          // 0001:T8.2: lift W3C trace context off the wake envelope (the gateway
          // injected it onto the ingress send) and strip it so handler logic
          // never sees the transport metadata.
          const { parent, value } = takeTraceContext(input);
          return handleSpawn(adaptExclusive(ctx, parent), config, value);
        },
      ),
      message: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext, input: AgentMessageInput): Promise<WakeResult> => {
          const { parent, value } = takeTraceContext(input);
          return handleMessage(adaptExclusive(ctx, parent), config, value);
        },
      ),
      // 0001:T2.1's generic shared control channel — retained; only `interrupt` is
      // deliverable through it (pause/resume/archive need K/V writes a shared
      // handler cannot do → `unsupported`). The four 0001:T2.5 verbs below are the
      // typed public front doors.
      signal: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext, sig: AgentSignalInput): Promise<AgentSignalResult> =>
          handleSignal(adaptShared(ctx), config, sig),
      ),
      // 0001:T2.5 — interrupt is SHARED (must reach a busy exclusive wake, SPIKE §a).
      interrupt: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext, input: ControlInput = {}): Promise<InterruptResult> =>
          handleInterrupt(adaptShared(ctx), config, input),
      ),
      // 0001:T2.5 — pause/resume/archive are EXCLUSIVE (they write K/V); they
      // serialize behind any in-flight wake and take effect at invocation start.
      pause: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext, input: ControlInput = {}): Promise<PauseResult> =>
          handlePause(adaptExclusive(ctx), config, input),
      ),
      resume: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext, input: ControlInput = {}): Promise<ResumeResult> =>
          handleResume(adaptExclusive(ctx), config, input),
      ),
      archive: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext, input: ControlInput = {}): Promise<ArchiveResult> =>
          handleArchive(adaptExclusive(ctx), config, input),
      ),
      archiveTick: async (
        ctx: restate.ObjectContext,
        msg: ArchiveTickMessage,
      ): Promise<ArchiveTickResult> => handleArchiveTick(adaptExclusive(ctx), config, msg),
      subscribe: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext, input: SubscribeInput): Promise<SubscribeResult> =>
          handleSubscribe(adaptExclusive(ctx), config, input),
      ),
      unsubscribe: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext, input: SubscribeInput): Promise<UnsubscribeResult> =>
          handleUnsubscribe(adaptExclusive(ctx), config, input),
      ),
      notifyTick: async (
        ctx: restate.ObjectContext,
        msg: NotifyTickMessage,
      ): Promise<NotifyTickResult> => handleNotifyTick(adaptExclusive(ctx), config, msg),
      // 0002:T2.1 — the 0001:A9 reconcile seams (`createRestateEntityReconcileClient`
      // targets these names). `reconcileProbe` is SHARED: a cheap K/V read that
      // runs concurrently with a busy exclusive wake and never blocks behind
      // it (0001:A6#4). `reconcileFlush`/`reconcileRecovery` are EXCLUSIVE:
      // they drive the outbox / execute the epoch reset, and the single-writer
      // owns that K/V (the reconciler only REQUESTS — the 0001:A9 split).
      reconcileProbe: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext): Promise<EntityProbe | null> =>
          handleReconcileProbe(adaptShared(ctx)),
      ),
      reconcileFlush: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext): Promise<FlushDriveOutcome> => {
          const entityId = agentEntityUrl(config.tenant ?? "default", config.entityType, ctx.key);
          return handleReconcileFlush(adaptExclusive(ctx), config.outbox, entityId);
        },
      ),
      reconcileRecovery: restate.handlers.object.exclusive(
        handlerOpts,
        async (
          ctx: restate.ObjectContext,
          input: ReconcileRecoveryInput,
        ): Promise<ReconcileRecoveryResult> => {
          const entityId = agentEntityUrl(config.tenant ?? "default", config.entityType, ctx.key);
          return handleReconcileRecovery(
            adaptExclusive(ctx),
            {
              outbox: config.outbox,
              ...(config.archiveSnapshotMaxBytes !== undefined && {
                archiveSnapshotMaxBytes: config.archiveSnapshotMaxBytes,
              }),
              contextOpaqueOrigins: resolved(config).contextOpaqueOrigins,
            },
            entityId,
            input,
          );
        },
      ),
    },
    options: { explicitCancellation: true },
  });
}

export type AgentObject = ReturnType<typeof createAgentObject>;
