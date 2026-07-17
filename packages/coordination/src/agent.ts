/**
 * `agent.<type>` — T2.1: the agent virtual object skeleton.
 *
 * Implements D2's coordination heart: agent = Restate virtual object, service
 * `agent.<type>` keyed by instance id (A3, docs/addressing.md §6); one wake =
 * one exclusive invocation; single-writer per key; long chats = many
 * invocations with bounded journals (R4/A4).
 *
 * ## Template, not instance (the T6.1 seam)
 *
 * This module is a GENERIC TEMPLATE: `createAgentObject(config)` produces one
 * Restate virtual-object definition for one agent type. The Agents SDK
 * (T6.1 `defineAgent`) specializes it by supplying the config — `entityType`
 * (which becomes the service name `agent.<type>`), the `Harness` (D5),
 * tools, spawn/message validators (from its zod schemas), and the real seam
 * implementations (outbox T2.2, notifier T2.3, steer source T2.6). T2.1
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
 *   run; A4/SPIKE §a). `interrupt` reads `currentInvocationId` from K/V —
 *   visible live while the exclusive wake runs — and `ctx.cancel`s it. This
 *   is the seam T2.5 builds the full verb API on; see `handleSignal`.
 * - `archiveTick(msg)` — the idle→archive self-scheduled check (D7),
 *   generation-guarded like cron.ts. The archive body itself is T8.1; the
 *   seq/head_seq contract it must honor is documented at `handleArchiveTick`.
 *
 * ## Invocation flow (every wake)
 *
 * validate → apply (record wake input events) → run harness (one `ctx.run`,
 * raced against interrupt-cancellation, abort-signal-merged per A4) →
 * collect events → project via the outbox seam in bounded chunks (T2.2,
 * A1/R4) → notify seam (T2.3) → re-arm the archive timer.
 *
 * ## A4 discipline baked in
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
  type ChildFinishedNotification,
  type ProjectionOutbox,
} from "./agent-seams.js";
import {
  addSubscriber,
  handleSubscriberNotifyTick,
  notifyParentOrDeadLetter,
  removeSubscriber,
  scheduleSubscriberNotify,
  type EntityDirectory,
  type NotifyTickMessage,
  type NotifyTickResult,
  type SubscribeResult,
  type UnsubscribeResult,
} from "./messaging.js";

// ---------------------------------------------------------------------------
// Naming (A3 / docs/addressing.md §6)
// ---------------------------------------------------------------------------

export const AGENT_SERVICE_PREFIX = "agent." as const;

const TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Restate service name for an agent type: `agent.<type>` (A3-confirmed). */
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
// Config (what T6.1 `defineAgent` compiles onto this template)
// ---------------------------------------------------------------------------

export interface AgentObjectConfig {
  /** Agent type; realizes the Restate service `agent.<type>` (A3). Charset per addressing §2.3. */
  entityType: string;
  /** Deployment tenant (addressing §1). Default `"default"`. */
  tenant?: string;
  /** The harness that owns the LLM loop (D5). Stub until Phase 3. */
  harness: Harness;
  tools?: readonly AnyToolDefinition[];
  /** Projection outbox seam — the ONLY seq allocator + stream writer (T2.2). */
  outbox: ProjectionOutbox;
  /** Messaging/notify seam (T2.3). */
  notifier: AgentNotifier;
  /**
   * Entity-status lookup for dead-letter detection (T2.3, D1 catalog). When
   * set, an undeliverable `child_finished` back-send (parent gone/archived)
   * stages an `error` event on this entity's own timeline instead of vanishing
   * (D2 "never silent"); the arbitrary `send` verb uses it too (messaging.ts
   * `sendToAgent`). When absent, notifications are best-effort fire-and-forget
   * (the T2.1 behavior — no dead-letter).
   */
  directory?: EntityDirectory;
  /**
   * Debounce window for subscriber notifications (T2.3, D2 pub/sub). `> 0`:
   * a wake that changed observable state arms a coalescing `notifyTick`
   * self-send (delayed by this many ms) instead of fanning out inline, so a
   * burst of wakes collapses to one `subscription_update` per subscriber.
   * `0`: notify inline every wake (no debounce). Default
   * `DEFAULT_SUBSCRIBER_NOTIFY_DEBOUNCE_MS`.
   */
  subscriberNotifyDebounceMs?: number;
  /** Steerbox drain (T2.6). Default: nothing ever queued. */
  steerSource?: SteerSource;
  /** Token-delta sink (platform wiring, T5.1). Default: no-op. */
  emitDelta?: EmitDelta;
  /** T6.1 hook: validate/normalize spawn args (throw `TerminalError` to reject). */
  validateSpawnArgs?: (args: JsonValue | undefined) => JsonValue | undefined;
  /** T6.1 hook: validate/normalize an inbound message (throw `TerminalError` to reject). */
  validateMessage?: (input: AgentMessageInput) => AgentMessageInput;
  /** Idle window before the archive check fires (D7). `0` disables. Default 30 min. */
  idleArchiveDelayMs?: number;
  /** Events per bounded outbox stage+flush chunk (R4). Default 16. */
  outboxChunkSize?: number;
  /**
   * Per-handler Restate timeouts (A4 rule 3): MUST exceed the worst-case
   * harness step latency, or aborted attempts zombie-loop. Defaults: 10 min
   * inactivity, 10 min abort.
   */
  inactivityTimeoutMs?: number;
  abortTimeoutMs?: number;
  /**
   * Opaque-event origins retained in the K/V context for the owning
   * harness's cold rebuild (T7.1). Default: `[harness.kind]`.
   */
  contextOpaqueOrigins?: readonly string[];
}

export const DEFAULT_IDLE_ARCHIVE_DELAY_MS = 30 * 60_000;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_ABORT_TIMEOUT_MS = 10 * 60_000;
/** Coalescing window for subscriber notifications (T2.3, D2 debounce). */
export const DEFAULT_SUBSCRIBER_NOTIFY_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Handler inputs / results
// ---------------------------------------------------------------------------

export interface AgentSpawnInput {
  /** Validated further by `config.validateSpawnArgs` (T6.1 spawnSchema). */
  args?: JsonValue;
  /** Parent entity url (D2: spawn carries the parent's key). */
  parentRef?: string | null;
  /** Workspace key `<tenant>/<name>` (D4: chosen at spawn, never switched). */
  workspaceRef?: string;
  /** Initial subscriber entity urls (management beyond spawn is T2.3). */
  subscribers?: string[];
}

/**
 * The `message` wake payload. Discriminated: plain messages, plus the two
 * platform-typed deliveries the stub notifier (and later T2.3) produces.
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

export type ArchiveTickResult = {
  archived: false;
  reason: "stale-epoch" | "not-idle" | "not-implemented";
};
// T8.1 extends this with `{ archived: true; snapshotSeq: number }`.

export interface WakeResult {
  entityId: string;
  /** Head seq after this wake (last event confirmed to the outbox). */
  headSeq: number | null;
  outcome: RunOutcome;
}

export interface SpawnResult {
  /** False on idempotent reattach (addressing §3.3) — no re-init, no events. */
  created: boolean;
  entityId: string;
  headSeq: number | null;
  outcome?: RunOutcome;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();

function resolved(config: AgentObjectConfig) {
  return {
    tenant: config.tenant ?? "default",
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
 * Merge freshly committed events into the bounded K/V context (D1): keep
 * context-bearing events (+ owning-harness opaques), apply the
 * summarization fold — which is the bounding mechanism — via the shared
 * normative selector (T3.1 `selectContextEvents`).
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

async function scheduleArchiveTick(ctx: AgentRuntimeCtx, config: AgentObjectConfig): Promise<void> {
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
 * The shared wake pipeline: flush leftovers → record wake input +
 * run_started → harness (raced against interrupt) → commit events +
 * run_finished in bounded chunks → update context/usage K/V → notify →
 * re-arm archive timer.
 */
async function runWake(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  entityId: string,
  spec: WakeSpec,
): Promise<WakeResult> {
  const r = resolved(config);
  let outcome: RunOutcome;

  // The interrupt target (A4): shared `signal` reads this live (SPIKE §a-2/3).
  ctx.set(AGENT_KV.currentInvocationId, ctx.invocationId);
  ctx.set<EntityStatus>(AGENT_KV.status, "active");
  try {
    // D3: retry any outbox left over from a previous crashed wake FIRST, so
    // stream order is preserved before new seqs pile up behind it.
    await config.outbox.flush(ctx, entityId);

    const startedAt = await ctx.run("now", () => Date.now());
    const runId = ctx.invocationId; // replay-stable across attempts of this invocation
    const runStarted: TimelineEventInit = {
      type: "run_started",
      ts: iso(startedAt),
      payload: {
        runId,
        wake: { source: spec.wake.source, ...(spec.wake.from !== undefined && { from: spec.wake.from }) },
        // The frozen schema enumerates the two real harnesses; anything else
        // (the T2.1 stub) records as the native slot it stands in for.
        harness: config.harness.kind === "casdk" ? "casdk" : "native",
      },
    };
    const head = await commitEventsChunked(
      ctx,
      config.outbox,
      entityId,
      [...spec.preEvents, runStarted],
      r.outboxChunkSize,
    );
    await updateContextKv(ctx, config, head);

    const canonicalContext = (await ctx.get<TimelineEvent[]>(AGENT_KV.context)) ?? [];
    try {
      // ONE journaled step for the whole (stub) harness run, raced against
      // the interrupt-cancellation, closure abortable per A4. The
      // step-durable native harness (T3.2) will instead take
      // `commitEvents` and journal per LLM step — same seam, finer grain.
      const result = await ctx.raceInterrupt(
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
        // explicitCancellation (A4): durable steps still work here. Record
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
        // error event (D5): record it, keep the entity consistent and live.
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
        // holds anything staged-but-unflushed and replays in order (D3).
        throw err;
      }
    }
  } finally {
    ctx.clear(AGENT_KV.currentInvocationId);
  }

  ctx.set<EntityStatus>(AGENT_KV.status, "idle");

  // Notify seam (T2.3). child_finished back-send first: with a directory it is
  // dead-letter-checked (a gone/archived parent stages an `error` on THIS
  // timeline, D2 "never silent") — which appends events, so head_seq is read
  // AFTER it. Without a directory it stays best-effort fire-and-forget (T2.1).
  if (spec.notifyParentRef) {
    const note: ChildFinishedNotification = {
      childId: entityId,
      outcome: outcome === "success" ? "success" : outcome,
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

  // Subscriber pub/sub (D2): debounced via a coalescing `notifyTick` self-send
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

// ---------------------------------------------------------------------------
// Handlers (logic — unit-testable against fakes; see agent.test.ts)
// ---------------------------------------------------------------------------

/**
 * First wake. Writes `entity_spawned` at seq 0 through the outbox (A1: the
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
    // Reattach. NOTE (open question for T6.1): detecting materially
    // different re-spawn args (addressing §3.3 wants an `error` event then)
    // requires retaining the original args for comparison — deferred to
    // defineAgent, which owns the spawn schema.
    return { created: false, entityId, headSeq: headSeqOf(existingSeq) };
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
    // context (entity_spawned itself is not context-bearing). T6.1's
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
  return { created: true, entityId, headSeq: result.headSeq, outcome: result.outcome };
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
    // Never spawned — or archived-and-cleared. Resurrection from the catalog
    // snapshot is T8.1; until then this is a terminal, visible failure
    // (dead-lettering onto the SENDER's timeline is T2.3).
    throw new restate.TerminalError(
      `agent ${entityId} has no live state (not spawned, or archived — resurrection is T8.1)`,
    );
  }

  const input = config.validateMessage ? config.validateMessage(rawInput) : rawInput;
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
 * SHARED control channel (A4/SPIKE §a) — runs concurrently with a busy
 * exclusive wake; K/V is read-only here, so control is expressed as
 * invocation-cancel + one-way sends, never direct state writes.
 *
 * T2.1 wires the one verb the skeleton needs — `interrupt`: read the
 * in-flight `currentInvocationId` (visible live) and `ctx.cancel` it; the
 * exclusive wake's `raceInterrupt` then aborts the harness (~20 ms),
 * records `control` + `run_finished(interrupted)` durably, and the entity
 * stays immediately messageable. Idle entity → `delivered: false, "idle"`
 * (nothing to interrupt; interrupting a QUEUED wake is a T2.5 decision —
 * SPIKE §a-6 shows queued invocations cancel cleanly if wanted).
 *
 * `pause`/`resume`/`archive` return `"unsupported"` here — **T2.5 builds the
 * full verb API on this exact seam** (same handler, same shared-context
 * constraints; pause/resume as status flags checked at wake start, archive
 * delegating to the T8.1 path).
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
 * Idle→archive check (D7), self-scheduled with the cron.ts generation-guard
 * pattern: every wake bumps `archiveEpoch` and queues a delayed tick; a tick
 * whose epoch is stale (activity happened since) is a pure no-op.
 *
 * TODO(T8.1) — the archive body. Contract it must honor (frozen by the
 * schema, A5):
 *  1. commit `state_snapshot(reason: "pre_archive")` through the outbox —
 *     it OCCUPIES a seq slot N and asserts the complete state as of seq N
 *     inclusive;
 *  2. commit the terminal `archived` event at seq N+1 with
 *     `snapshotSeq: N`;
 *  3. write the compact snapshot + `snapshot_offset` + status to the catalog
 *     row via `ctx.run` (D1), bounded at write time (it is the bounded
 *     context, not the timeline);
 *  4. clear ALL K/V (including `seq`) — Restate holds the working set only;
 *  5. resurrection (a later message) rehydrates from the CATALOG snapshot
 *     (never the stream) and CONTINUES the same seq counter from the
 *     catalog's `head_seq` (= N+1's successor), so the producer sequence
 *     stays gapless (A1).
 */
export async function handleArchiveTick(
  ctx: AgentRuntimeCtx,
  _config: AgentObjectConfig,
  msg: ArchiveTickMessage,
): Promise<ArchiveTickResult> {
  const epoch = (await ctx.get<number>(AGENT_KV.archiveEpoch)) ?? 0;
  if (msg.epoch !== epoch) return { archived: false, reason: "stale-epoch" };
  const status = await ctx.get<EntityStatus>(AGENT_KV.status);
  if (status !== "idle") return { archived: false, reason: "not-idle" };
  return { archived: false, reason: "not-implemented" };
}

/**
 * Register a subscriber for this entity's `subscription_update` notifications
 * (D2 pub/sub). Idempotent — re-subscribing the same url is a no-op. Requires
 * live state (subscribing to a never-spawned/archived entity is a terminal,
 * visible failure; resurrection is T8.1). Exclusive handler: it mutates the
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
      `subscribe: agent ${entityId} has no live state (not spawned, or archived — T8.1)`,
    );
  }
  const list = (await ctx.get<string[]>(AGENT_KV.subscribers)) ?? [];
  const next = addSubscriber(list, input.subscriberRef);
  ctx.set(AGENT_KV.subscribers, next);
  return { subscribed: next.length !== list.length, count: next.length };
}

/** Remove a subscriber (D2 pub/sub). Idempotent; same constraints as `subscribe`. */
export async function handleUnsubscribe(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  input: SubscribeInput,
): Promise<UnsubscribeResult> {
  const r = resolved(config);
  const entityId = agentEntityUrl(r.tenant, config.entityType, ctx.key);
  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    throw new restate.TerminalError(
      `unsubscribe: agent ${entityId} has no live state (not spawned, or archived — T8.1)`,
    );
  }
  const list = (await ctx.get<string[]>(AGENT_KV.subscribers)) ?? [];
  const next = removeSubscriber(list, input.subscriberRef);
  ctx.set(AGENT_KV.subscribers, next);
  return { unsubscribed: next.length !== list.length, count: next.length };
}

/**
 * The subscriber-notify debounce tick (T2.3, D2). Internal — armed only by
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

function adaptExclusive(ctx: restate.ObjectContext): AgentRuntimeCtx {
  // A4 interrupt seam (SPIKE §a recommended pattern, verbatim): the
  // cancellation promise is @experimental in SDK 1.16 — the SDK version is
  // pinned and the seam is a conformance-kit item (T6.3/T9.1).
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
 * Build the `agent.<type>` virtual object from a config (the T6.1 seam —
 * `defineAgent` compiles its typed definition into exactly this call).
 *
 * `explicitCancellation: true` is MANDATORY (A4): without it, post-interrupt
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
        async (ctx: restate.ObjectContext, input: AgentSpawnInput): Promise<SpawnResult> =>
          handleSpawn(adaptExclusive(ctx), config, input),
      ),
      message: restate.handlers.object.exclusive(
        handlerOpts,
        async (ctx: restate.ObjectContext, input: AgentMessageInput): Promise<WakeResult> =>
          handleMessage(adaptExclusive(ctx), config, input),
      ),
      signal: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext, sig: AgentSignalInput): Promise<AgentSignalResult> =>
          handleSignal(adaptShared(ctx), config, sig),
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
    },
    options: { explicitCancellation: true },
  });
}

export type AgentObject = ReturnType<typeof createAgentObject>;
