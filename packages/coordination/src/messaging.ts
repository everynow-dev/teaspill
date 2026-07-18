/**
 * 0001:T2.3 — Messaging, spawn, pub/sub (0001:D2 coordination primitives).
 *
 * This module layers the higher-level messaging behaviors on top of the
 * fire-and-forget `AgentNotifier` seam (agent-seams.ts): parent→child spawn,
 * arbitrary inter-agent `send`, subscriber-notify debounce, dead-letter, and
 * the fan-out "gather N results" accumulator. Everything here is written
 * against the small structural `AgentRuntimeCtx` (agent-runtime.ts) so it is
 * unit-testable against the in-memory fakes (messaging.test.ts), exactly like
 * cron.ts / agent.ts.
 *
 * ## Where each PLAN-0001:T2.3 deliverable lives
 *
 * - **spawn (parent→child)** — `spawnChild`: one-way `spawn` send to
 *   `agent.<childType>` keyed by the child id (0001:D2 "spawn = one-way durable
 *   send carrying parentRef"); returns the `child_spawned` event the PARENT
 *   commits to its own timeline. `child_finished` back-send is the agent
 *   object's job (agent.ts `runWake` → `notifyParentOrDeadLetter`).
 * - **send (arbitrary agents)** — `sendToAgent`: a general one-way `message`
 *   send with dead-letter.
 * - **subscriber notify + debounce** — `scheduleSubscriberNotify` (delayed
 *   self-send + K/V dirty flag + generation guard, the cron.ts discipline)
 *   and `handleSubscriberNotifyTick` (the coalesced fan-out).
 * - **dead-letter** — `stageDeadLetterError`, used by `sendToAgent` and
 *   `notifyParentOrDeadLetter`: a send to a nonexistent / archived target
 *   stages an `error` event (source `platform`) on the SENDER's timeline
 *   (0001:D2 "never silent"), via the outbox.
 * - **gather N results** — `createGather` / `recordGatherResult` /
 *   `accumulateChildResult`: a state machine (each `child_finished` arrives as
 *   a SEPARATE invocation, 0001:D2) that accumulates results in agent state until N
 *   are collected. Surfaced to developers by 0001:T6.1.
 *
 * ## Dead-letter detection (decision + rationale)
 *
 * A one-way `genericSend` is fire-and-forget: Restate lazily creates the
 * target virtual object, so a send to a never-spawned key does NOT fail at the
 * sender — the failure surfaces only later, on the TARGET's `message` handler
 * ("no live state"), invisible to the sender. To make dead-letters visible on
 * the SENDER's timeline (0001:D2), detection is a **catalog status check** via the
 * `EntityDirectory` seam BEFORE the send, not a Restate call-failure probe
 * (which would either block the wake with a request/response call or, for a
 * missing key, not fail at all). This is 0001:D1-consistent: the catalog is the
 * entity registry with `status`; the real adapter reads it inside `ctx.run`
 * (see projection-catalog.ts `createDrizzleEntityDirectory`).
 *
 * Trade-offs, documented rather than hidden:
 * - **TOCTOU:** the target can change status between the check and delivery.
 *   Dead-letter is best-effort visibility, not a delivery guarantee — the
 *   point is "never silent", accepted per 0001:D2.
 * - **archived ⇒ RESURRECTS (0001:T8.1):** `DEFAULT_DEAD_STATUSES = []`. A message
 *   to an archived entity is now DELIVERABLE — the target's `message` handler
 *   rehydrates it from the catalog snapshot (agent.ts `resurrectFromCatalog`),
 *   continuing the seq counter from `head_seq` (0001:A5). Dead-lettering an archived
 *   target would strand it, so `archived` was removed from the default dead
 *   set. Only a nonexistent target (`entry === null`) or an invalid url still
 *   dead-letters. Callers that deliberately disable resurrection can pass
 *   `deadStatuses: ["archived"]` to restore the pre-0001:T8.1 behavior.
 * - **notifications are best-effort:** subscriber fan-out is NOT dead-letter
 *   checked (pub/sub is lossy by nature and a per-subscriber catalog read per
 *   tick is too costly); a dead subscriber's `subscription_update` simply
 *   fails on the target side. Unsubscribe / a future GC is the cure.
 */

import type { ContentBlock, JsonValue, TimelineEventInit } from "@teaspill/schema";
import {
  AGENT_KV,
  headSeqOf,
  type AgentRuntimeCtx,
  type EntityStatus,
} from "./agent-runtime.js";
import {
  agentTargetOf,
  commitEventsChunked,
  parseEntityUrlLite,
  type AgentNotifier,
  type ChildFinishedNotification,
  type ProjectionOutbox,
} from "./agent-seams.js";

const iso = (ms: number): string => new Date(ms).toISOString();

// ===========================================================================
// K/V owned by this module (additive to AGENT_KV; same object namespace)
// ===========================================================================

export const MESSAGING_KV = {
  /**
   * `number` — generation guard for the subscriber-notify debounce timer,
   * same discipline as cron.ts: every `scheduleSubscriberNotify` bumps it and
   * self-sends a `notifyTick({ gen })`; a tick whose `gen` doesn't match
   * current K/V is stale (a newer state change reset the debounce window) and
   * is a no-op. Delayed sends cannot be revoked by content, so the guard is
   * the ONLY way to retire a superseded tick.
   */
  notifyGen: "notifyGen",
  /**
   * `boolean` — the debounce dirty flag: observable state changed since the
   * last fan-out and subscribers have not yet been told. Set by
   * `scheduleSubscriberNotify`, cleared by `handleSubscriberNotifyTick` after
   * the coalesced fan-out (or when there is nothing to notify).
   */
  notifyDirty: "notifyDirty",
} as const;

// ===========================================================================
// Dead-letter detection seam (0001:D1 catalog status)
// ===========================================================================

export interface EntityDirectoryEntry {
  status: EntityStatus;
}

/**
 * Reads an entity's registry status (0001:D1 catalog). Real adapter over Drizzle
 * lives in projection-catalog.ts (`createDrizzleEntityDirectory`) and wraps
 * its query in `ctx.run`; `InMemoryEntityDirectory` below serves the tests.
 * `lookup` returns `null` when no row exists (never spawned / unknown).
 */
export interface EntityDirectory {
  lookup(ctx: AgentRuntimeCtx, entityId: string): Promise<EntityDirectoryEntry | null>;
}

/** In-memory `EntityDirectory` for unit tests. */
export class InMemoryEntityDirectory implements EntityDirectory {
  readonly #entries = new Map<string, EntityStatus>();
  set(entityId: string, status: EntityStatus): this {
    this.#entries.set(entityId, status);
    return this;
  }
  remove(entityId: string): this {
    this.#entries.delete(entityId);
    return this;
  }
  lookup(_ctx: AgentRuntimeCtx, entityId: string): Promise<EntityDirectoryEntry | null> {
    const status = this.#entries.get(entityId);
    return Promise.resolve(status === undefined ? null : { status });
  }
}

/**
 * Statuses treated as un-deliverable. **EMPTY by default (0001:T8.1):** `archived`
 * is no longer dead — a send to an archived entity RESURRECTS it (the message
 * handler rehydrates from the catalog snapshot; see agent.ts
 * `resurrectFromCatalog` and DECISIONS "Note — dead-letter vs resurrection").
 * Only a nonexistent target (no catalog row, `entry === null`) or an invalid
 * url still dead-letters — those are handled independently of this set. The
 * set stays overridable via `deadStatuses` (e.g. a deployment that disables
 * resurrection and wants archived treated as terminal passes `["archived"]`).
 */
export const DEFAULT_DEAD_STATUSES: readonly EntityStatus[] = [];

export type DeadLetterReason = "not_found" | "dead_status" | "invalid_target";

/**
 * Stage an `error` event (source `platform`) on the SENDER's own timeline for
 * an undeliverable send (0001:D2 "never silent"), through the outbox (so it gets a
 * seq and lands on the stream). Returns the finalized head after the flush.
 */
export async function stageDeadLetterError(
  ctx: AgentRuntimeCtx,
  outbox: ProjectionOutbox,
  senderId: string,
  detail: { to: string; reason: DeadLetterReason; status?: EntityStatus | null; verb: string },
): Promise<void> {
  const now = await ctx.run("now-deadletter", () => Date.now());
  const message =
    `dead-letter: ${detail.verb} to ${detail.to} — ${detail.reason}` +
    (detail.status ? ` (status ${detail.status})` : "");
  const event: TimelineEventInit = {
    type: "error",
    ts: iso(now),
    payload: {
      code: "dead_letter",
      message,
      source: "platform",
      detail: {
        to: detail.to,
        reason: detail.reason,
        verb: detail.verb,
        ...(detail.status != null && { status: detail.status }),
      },
    },
  };
  await commitEventsChunked(ctx, outbox, senderId, [event]);
}

// ===========================================================================
// send — arbitrary inter-agent one-way message (with dead-letter)
// ===========================================================================

export interface SendResult {
  delivered: boolean;
  reason?: DeadLetterReason;
  targetStatus?: EntityStatus | null;
}

export interface SendToAgentOptions {
  outbox: ProjectionOutbox;
  directory: EntityDirectory;
  notifier: AgentNotifier;
  /** The sending entity's url (dead-letter errors land on ITS timeline). */
  senderId: string;
  /** Target entity url. */
  to: string;
  content: readonly ContentBlock[];
  source?: "message" | "system";
  deadStatuses?: readonly EntityStatus[];
}

/**
 * The `send` verb: a general one-way `message` send between arbitrary agents
 * (0001:T3.3's `send_message` tool is the first caller). Checks the target's
 * catalog status first; a nonexistent / archived target dead-letters onto the
 * sender's timeline instead of delivering silently (0001:D2).
 */
export async function sendToAgent(
  ctx: AgentRuntimeCtx,
  opts: SendToAgentOptions,
): Promise<SendResult> {
  const deadStatuses = opts.deadStatuses ?? DEFAULT_DEAD_STATUSES;
  if (!parseEntityUrlLite(opts.to)) {
    await stageDeadLetterError(ctx, opts.outbox, opts.senderId, {
      to: opts.to,
      reason: "invalid_target",
      verb: "send",
    });
    return { delivered: false, reason: "invalid_target" };
  }
  const entry = await opts.directory.lookup(ctx, opts.to);
  if (entry === null) {
    await stageDeadLetterError(ctx, opts.outbox, opts.senderId, {
      to: opts.to,
      reason: "not_found",
      verb: "send",
    });
    return { delivered: false, reason: "not_found", targetStatus: null };
  }
  if (deadStatuses.includes(entry.status)) {
    await stageDeadLetterError(ctx, opts.outbox, opts.senderId, {
      to: opts.to,
      reason: "dead_status",
      status: entry.status,
      verb: "send",
    });
    return { delivered: false, reason: "dead_status", targetStatus: entry.status };
  }
  opts.notifier.send(ctx, opts.to, {
    content: opts.content,
    from: opts.senderId,
    ...(opts.source !== undefined && { source: opts.source }),
  });
  return { delivered: true, targetStatus: entry.status };
}

// ===========================================================================
// spawn — parent→child (one-way send carrying parentRef) + child_spawned
// ===========================================================================

export interface SpawnChildRequest {
  /** Child entity url (`/t/<tenant>/a/<childType>/<childId>`). */
  childRef: string;
  /** The spawning parent's entity url (0001:D2: spawn carries the parent's key). */
  parentRef: string;
  /** Validated spawn args, forwarded verbatim to the child's `spawn` handler. */
  args?: JsonValue;
  /** Workspace key chosen at spawn (0001:D4). */
  workspaceRef?: string;
  /** Initial subscriber urls for the child. */
  subscribers?: string[];
  /** The parent run that issued the spawn (for the `child_spawned` event). */
  runId?: string;
  /** The spawning tool-use id, when spawned by a tool. */
  toolUseId?: string;
}

/**
 * Fire the parent→child spawn as a one-way durable `spawn` send to
 * `agent.<childType>` keyed by the child id, carrying `parentRef` (0001:D2). Returns
 * the `child_spawned` event init the PARENT must commit to its own timeline —
 * the caller (0001:T3.3 spawn tool / harness step) stages it through the outbox so
 * the parent records the child. Spawning never dead-letters: a repeat spawn on
 * an existing child key is an idempotent reattach (addressing §3.3).
 */
export async function spawnChild(
  ctx: AgentRuntimeCtx,
  req: SpawnChildRequest,
): Promise<TimelineEventInit> {
  const parsed = parseEntityUrlLite(req.childRef);
  if (!parsed) throw new Error(`spawnChild: not a canonical child url: ${JSON.stringify(req.childRef)}`);
  const target = agentTargetOf(req.childRef);
  ctx.genericSend({
    service: target.service,
    method: "spawn",
    key: target.key,
    parameter: {
      parentRef: req.parentRef,
      ...(req.args !== undefined && { args: req.args }),
      ...(req.workspaceRef !== undefined && { workspaceRef: req.workspaceRef }),
      ...(req.subscribers !== undefined && { subscribers: req.subscribers }),
    },
  });
  // `ts` is informational (ordering authority is seq) but still read through
  // ctx.run so the event is replay-stable (0001:D2: no naked clock reads).
  const now = await ctx.run("now-spawn-child", () => Date.now());
  return {
    type: "child_spawned",
    ts: iso(now),
    payload: {
      childId: req.childRef,
      childType: parsed.type,
      ...(req.runId !== undefined && { runId: req.runId }),
      ...(req.toolUseId !== undefined && { toolUseId: req.toolUseId }),
    },
  };
}

// ===========================================================================
// child_finished back-send with dead-letter
// ===========================================================================

/**
 * Send `child_finished` back to the parent (0001:D2 completion). If the parent is
 * gone (no catalog row) or archived, the notification dead-letters onto the
 * CHILD's own timeline instead of vanishing (0001:D2 "never silent").
 */
export async function notifyParentOrDeadLetter(
  ctx: AgentRuntimeCtx,
  opts: {
    outbox: ProjectionOutbox;
    directory: EntityDirectory;
    notifier: AgentNotifier;
    childId: string;
    parentRef: string;
    note: ChildFinishedNotification;
    deadStatuses?: readonly EntityStatus[];
  },
): Promise<SendResult> {
  const deadStatuses = opts.deadStatuses ?? DEFAULT_DEAD_STATUSES;
  const entry = parseEntityUrlLite(opts.parentRef)
    ? await opts.directory.lookup(ctx, opts.parentRef)
    : undefined;
  if (entry === undefined) {
    await stageDeadLetterError(ctx, opts.outbox, opts.childId, {
      to: opts.parentRef,
      reason: "invalid_target",
      verb: "child_finished",
    });
    return { delivered: false, reason: "invalid_target" };
  }
  if (entry === null) {
    await stageDeadLetterError(ctx, opts.outbox, opts.childId, {
      to: opts.parentRef,
      reason: "not_found",
      verb: "child_finished",
    });
    return { delivered: false, reason: "not_found", targetStatus: null };
  }
  if (deadStatuses.includes(entry.status)) {
    await stageDeadLetterError(ctx, opts.outbox, opts.childId, {
      to: opts.parentRef,
      reason: "dead_status",
      status: entry.status,
      verb: "child_finished",
    });
    return { delivered: false, reason: "dead_status", targetStatus: entry.status };
  }
  opts.notifier.notifyParent(ctx, opts.parentRef, opts.note);
  return { delivered: true, targetStatus: entry.status };
}

// ===========================================================================
// Subscriber notify — debounce (delayed self-send + dirty flag + gen guard)
// ===========================================================================

export interface NotifyTickMessage {
  /** The generation this debounce tick was minted under (cron-style guard). */
  gen: number;
}

export type NotifyTickResult =
  | { notified: number }
  | { notified: 0; reason: "stale-gen" | "not-dirty" | "no-subscribers" };

/**
 * Arm (or reset) the subscriber-notify debounce timer after an observable
 * state change. Bumps `notifyGen`, sets the dirty flag, and issues one delayed
 * self-send of `notifyTick({ gen })`. A burst of wakes within `debounceMs`
 * keeps bumping the generation, so only the LAST-armed tick survives the guard
 * and fires exactly one coalesced fan-out (cron.ts generation-guard
 * discipline). Returns the generation it armed.
 */
export async function scheduleSubscriberNotify(
  ctx: AgentRuntimeCtx,
  opts: { service: string; debounceMs: number },
): Promise<number> {
  const gen = ((await ctx.get<number>(MESSAGING_KV.notifyGen)) ?? 0) + 1;
  ctx.set(MESSAGING_KV.notifyGen, gen);
  ctx.set(MESSAGING_KV.notifyDirty, true);
  ctx.genericSend({
    service: opts.service,
    method: "notifyTick",
    key: ctx.key,
    parameter: { gen } satisfies NotifyTickMessage,
    delay: Math.max(0, opts.debounceMs),
  });
  return gen;
}

/**
 * The coalesced fan-out: fire one `subscription_update` to every current
 * subscriber, reading fresh head/status at fire time. No-op (without
 * notifying) when the tick is stale (a newer change reset the timer), when the
 * dirty flag is already clear (nothing accumulated), or when there are no
 * subscribers. Clears the dirty flag after a fan-out. Never produces timeline
 * events and never re-arms the archive timer — it is pure maintenance.
 */
export async function handleSubscriberNotifyTick(
  ctx: AgentRuntimeCtx,
  opts: { entityId: string; notifier: AgentNotifier; msg: NotifyTickMessage },
): Promise<NotifyTickResult> {
  const gen = (await ctx.get<number>(MESSAGING_KV.notifyGen)) ?? 0;
  if (opts.msg.gen !== gen) return { notified: 0, reason: "stale-gen" };
  const dirty = (await ctx.get<boolean>(MESSAGING_KV.notifyDirty)) ?? false;
  if (!dirty) return { notified: 0, reason: "not-dirty" };

  const subscribers = (await ctx.get<string[]>(AGENT_KV.subscribers)) ?? [];
  ctx.clear(MESSAGING_KV.notifyDirty);
  if (subscribers.length === 0) return { notified: 0, reason: "no-subscribers" };

  const headSeq = headSeqOf(await ctx.get<number>(AGENT_KV.seq));
  const status = (await ctx.get<EntityStatus>(AGENT_KV.status)) ?? "idle";
  opts.notifier.notifySubscribers(ctx, subscribers, { entityId: opts.entityId, headSeq, status });
  return { notified: subscribers.length };
}

// ===========================================================================
// Subscription management (subscribe / unsubscribe — pure list ops)
// ===========================================================================

export interface SubscribeResult {
  subscribed: boolean;
  count: number;
}
export interface UnsubscribeResult {
  unsubscribed: boolean;
  count: number;
}

/** Add a subscriber url to the list (idempotent). Pure over the array. */
export function addSubscriber(list: readonly string[], subscriberRef: string): string[] {
  return list.includes(subscriberRef) ? [...list] : [...list, subscriberRef];
}

/** Remove a subscriber url from the list. Pure over the array. */
export function removeSubscriber(list: readonly string[], subscriberRef: string): string[] {
  return list.filter((s) => s !== subscriberRef);
}

// ===========================================================================
// Gather N results — the fan-out accumulator state machine (0001:D2)
// ===========================================================================

export interface GatherResultEntry {
  childId: string;
  outcome: ChildFinishedNotification["outcome"];
  result?: JsonValue;
}

/**
 * Accumulator state for "gather N child results". Persisted in agent K/V
 * between wakes because each `child_finished` arrives as a SEPARATE exclusive
 * invocation (0001:D2) — the parallel-spawn case the upstream bug dropped. Kept
 * plain-JSON so it round-trips through Restate K/V.
 */
export interface GatherState {
  expected: number;
  results: GatherResultEntry[];
}

export function createGather(expected: number): GatherState {
  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error(`createGather: expected must be a non-negative integer, got ${expected}`);
  }
  return { expected, results: [] };
}

/**
 * Record one child's result. IDEMPOTENT by `childId`: a redelivered
 * `child_finished` (Restate at-least-once, or a retried wake) never
 * double-counts. Returns a new state (pure).
 */
export function recordGatherResult(state: GatherState, entry: GatherResultEntry): GatherState {
  if (state.results.some((r) => r.childId === entry.childId)) return state;
  return { expected: state.expected, results: [...state.results, entry] };
}

export function gatherRemaining(state: GatherState): number {
  return Math.max(0, state.expected - state.results.length);
}

export function isGatherComplete(state: GatherState): boolean {
  return state.results.length >= state.expected;
}

export interface AccumulateResult {
  complete: boolean;
  remaining: number;
  state: GatherState;
}

/**
 * K/V-bound gather helper for developer `onWake` handlers (0001:T6.1 surfaces it):
 * read the `GatherState` at `slotKey`, record `entry`, write it back, and
 * report completeness. On the first call the slot is initialized from
 * `opts.expected` (required if the slot is empty). Because each child result
 * lands as its own invocation, the K/V slot is the state machine's memory
 * across those invocations.
 */
export async function accumulateChildResult(
  ctx: AgentRuntimeCtx,
  slotKey: string,
  entry: GatherResultEntry,
  opts?: { expected?: number },
): Promise<AccumulateResult> {
  const existing = await ctx.get<GatherState>(slotKey);
  let state: GatherState;
  if (existing) {
    state = existing;
  } else {
    if (opts?.expected === undefined) {
      throw new Error(
        `accumulateChildResult: gather slot ${JSON.stringify(slotKey)} is uninitialized — ` +
          `pass { expected } on the first call (or seed it with createGather at spawn time).`,
      );
    }
    state = createGather(opts.expected);
  }
  const next = recordGatherResult(state, entry);
  ctx.set(slotKey, next);
  return { complete: isGatherComplete(next), remaining: gatherRemaining(next), state: next };
}
