/**
 * `steer/<entityId>` — 0001:T2.6: the steerbox companion object.
 *
 * Implements 0001:D2's steering clause: "a `steer/<entityId>` companion object
 * buffers messages sent while a run is in flight; harnesses drain it at
 * step/tool boundaries and inject into the live run. If the entity is idle,
 * a steer degrades to a normal message wake." Naming per docs/addressing.md
 * §6/§9 (0001:A3-confirmed on Restate 1.7.2/SDK 1.16.2, SPIKE-RESTATE.md §f):
 * service `steer`, key = the FULL canonical entity url (not the instance id
 * — one `steer` service serves every agent type, so the key must
 * disambiguate type+id, docs/addressing.md §6).
 *
 * ## Shape
 *
 * - `push(msg)` — append one message to the K/V queue. Assigns a monotonic
 *   per-key `ordinal` (from a K/V counter that survives drains) so pushes
 *   stay orderable/debuggable even after the queue they landed in has been
 *   cleared, and mints a default `id`/`ts` when the caller didn't supply one.
 * - `drain()` — return-and-clear the queue atomically (single-writer per
 *   key, 0001:D2), in push order. Exactly `SteerSource.drain()` from
 *   `@teaspill/harness-native`'s interface.ts — this object's `drain`
 *   handler and that interface method have the identical return shape by
 *   construction, so the adapter below is a thin transport, not a mapper.
 *
 * "Idempotent-ish" (PLAN 0001:T2.6): draining an empty queue is a pure no-op
 * (`[]`, no K/V write), and calling `drain()` again immediately after a
 * successful drain (no intervening `push`) also returns `[]` — the queue
 * was already cleared by the first call. This is the ordinary consequence
 * of single-writer K/V, not a separate mechanism; the counter's job is
 * ordering/introspection (`ordinal`), not drain deduplication.
 *
 * ## Two seams this module hands to callers it does not itself wire
 *
 * 1. **Mid-run vs idle routing** (`decideSteerRoute`) — a PURE decision
 *    function. The actual "is this entity mid-run" read, and the actual
 *    `push`/message dispatch, live at the caller (gateway `send(mode=steer)`
 *    handling, 0001:T1.2 — not built here; PLAN 0001:T2.6 is explicit that "the
 *    steerbox object itself just buffers; the routing lives at the
 *    caller"). See "Cheap status read" below for which status source to
 *    wire this to.
 * 2. **Wake-start drain, no-loss contract** (`drainAtWakeStart`) — a helper
 *    the agent object's `runWake` (agent.ts) should call as the very first
 *    step of every wake. NOT wired into agent.ts by this task (0001:T2.6 is
 *    scoped to this file; 0001:T2.5 touches agent.ts next — see the wire-in
 *    sketch on `drainAtWakeStart` below).
 *
 * ## Cheap status read — which one, and why
 *
 * PLAN's anticipate note offers two candidates: "catalog status or a shared
 * read handler on the agent object." This module recommends **a shared
 * handler on the agent object** (e.g. an additive `status()` shared
 * handler alongside 0001:T2.1's existing shared `signal` handler — NOT added to
 * agent.ts by this task, since 0001:T2.6's scope is this file only), for two
 * reasons:
 *
 * 1. **0001:D1 says so directly.** "Restate K/V ... is the ONLY store consulted
 *    for control flow" — routing a live `send` is control flow; the
 *    catalog is explicitly the write-only projection / archive-of-record,
 *    not a control-flow input.
 * 2. **It is measurably cheap and fresh.** SPIKE-RESTATE.md §a-1/2: a
 *    shared handler on a key with a busy exclusive invocation returns in
 *    ~21 ms and observes that invocation's K/V writes (`AGENT_KV.status`,
 *    set to `"active"`/`"idle"` in `agent.ts`'s `runWake`) in near-real
 *    time — no Postgres round trip, no replication lag. Catalog status is
 *    written best-effort per-wake and is not guaranteed to reflect
 *    "currently mid-run" at all (0001:D7's active/idle/archived lifecycle
 *    column is coarser than "an exclusive invocation is in flight right
 *    now").
 *
 * `decideSteerRoute` below is deliberately status-source-agnostic (it takes
 * an already-read `EntityStatus | null`) so it works with either source if
 * a future task disagrees — but the shared-handler read is the recommended
 * wiring, flagged here for whichever of 0001:T2.5 (control API, touches agent.ts
 * next) or 0001:T6.1 (`defineAgent`, compiles the object template) adds it.
 */

import * as restate from "@restatedev/restate-sdk";
import type { ContentBlock, TimelineEventInit } from "@teaspill/schema";
import type { SteerMessage, SteerSource } from "@teaspill/harness-native";
import type { EntityStatus } from "./agent-runtime.js";
import type { AgentMessageInput } from "./agent.js";

// ---------------------------------------------------------------------------
// Naming (0001:A3 / docs/addressing.md §6)
// ---------------------------------------------------------------------------

/** Restate service name for the steerbox object (docs/addressing.md §6/§9). */
export const STEER_SERVICE_NAME = "steer";

/**
 * Restate `{ service, key }` target for an entity's steerbox — service
 * `steer`, key = the full entity url (docs/addressing.md §6 `steerKey`).
 * Duplicated locally (like agent-seams.ts's `parseEntityUrlLite`) until the
 * shared addressing helpers land in `@teaspill/schema` (addressing.md's own
 * "reference implementation ... goes into packages/schema later, via a
 * follow-up task, not 0001:T0.2" note). No validation beyond non-empty — full
 * entity-url shape validation is addressing's job, not the steerbox's; an
 * arbitrary non-empty string is a legal Restate key (0001:A4 f-3: only the EMPTY
 * key is a footgun, and only ingress callers need guard against it).
 */
export function steerTarget(entityId: string): { service: typeof STEER_SERVICE_NAME; key: string } {
  if (!entityId) throw new Error("steerTarget: entityId must be non-empty");
  return { service: STEER_SERVICE_NAME, key: entityId };
}

// ---------------------------------------------------------------------------
// K/V layout
// ---------------------------------------------------------------------------

export const STEER_KV = {
  /** `SteerMessage[]` — pending queue, oldest first. Absent/empty ⇒ nothing buffered. */
  queue: "queue",
  /**
   * `number` — monotonic count of messages ever pushed to this key. NEVER
   * reset by `drain()` (only the queue is cleared) — it exists purely to
   * mint stable, ordered default ids/introspection ordinals across
   * multiple drain cycles, not to gate or deduplicate drains.
   */
  counter: "counter",
} as const;

// ---------------------------------------------------------------------------
// Handler inputs / results
// ---------------------------------------------------------------------------

export interface SteerPushInput {
  content: ContentBlock[];
  /** Sender entity url, when steered by another agent. */
  from?: string;
  /** Caller-supplied message id; default minted from the monotonic counter. */
  id?: string;
  /** Caller-supplied timestamp; default is wall-clock at push time (journaled via `ctx.run`). */
  ts?: string;
}

export interface SteerPushResult {
  /** This message's 0-based ordinal for THIS key, across all pushes ever (survives drains). Introspection only — never the canonical entity `seq` (0001:A1); steer messages are not canonical timeline events until/unless a harness folds them into the run. */
  ordinal: number;
  /** Queue length immediately after this push. */
  queued: number;
}

// ---------------------------------------------------------------------------
// Structural runtime context (cron.ts / agent-runtime.ts pattern) — handler
// LOGIC is written against this small subset of `restate.ObjectContext` so
// it is unit-testable against an in-memory fake with no live Restate server
// (see steer.test.ts). The real `restate.object(...)` wiring below is a thin
// adapter with no independent logic.
// ---------------------------------------------------------------------------

export interface SteerRuntimeCtx {
  readonly key: string;
  get<T>(name: string): Promise<T | null>;
  set<T>(name: string, value: T): void;
  clear(name: string): void;
  run<T>(name: string, action: () => T | Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Handler logic
// ---------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Append one message to the queue. Plain K/V read-modify-write on the
 * exclusive handler's context — atomic with the invocation under
 * single-writer-per-key (0001:D2), same discipline as every other object in this
 * package (cron.ts, agent.ts). The clock read for a default `ts` goes
 * through `ctx.run` (0001:D2: "all nondeterminism ... inside `ctx.run`"),
 * mirroring cron.ts's `ctx.run("now", () => Date.now())` pattern — even
 * though this handler otherwise does no I/O.
 */
export async function handlePush(ctx: SteerRuntimeCtx, input: SteerPushInput): Promise<SteerPushResult> {
  const ordinal = (await ctx.get<number>(STEER_KV.counter)) ?? 0;
  ctx.set(STEER_KV.counter, ordinal + 1);

  const ts = input.ts ?? iso(await ctx.run("now", () => Date.now()));
  const msg: SteerMessage = {
    id: input.id ?? `steer-${ordinal}`,
    ts,
    content: input.content,
    ...(input.from !== undefined && { from: input.from }),
  };

  const queue = (await ctx.get<SteerMessage[]>(STEER_KV.queue)) ?? [];
  const next = [...queue, msg];
  ctx.set(STEER_KV.queue, next);
  return { ordinal, queued: next.length };
}

/**
 * Return-and-clear the queue atomically. Empty queue ⇒ pure no-op (no K/V
 * write at all, not even a clear of an already-absent key) — this is what
 * makes repeated drains "idempotent-ish" (module header).
 */
export async function handleDrain(ctx: SteerRuntimeCtx): Promise<SteerMessage[]> {
  const queue = (await ctx.get<SteerMessage[]>(STEER_KV.queue)) ?? [];
  if (queue.length === 0) return [];
  ctx.clear(STEER_KV.queue);
  return queue;
}

// ---------------------------------------------------------------------------
// Restate wiring — thin adapter, no independent logic (cron.ts pattern).
// Exclusive (default) handlers: like cron.ts, push/drain are short K/V-only
// operations with no LLM/tool call to race against, so the `explicitCancellation`
// + `ctx.cancellation()` interrupt seam 0001:A4 mandates for agent/workspace
// objects is not load-bearing here.
// ---------------------------------------------------------------------------

function adapt(ctx: restate.ObjectContext): SteerRuntimeCtx {
  return {
    key: ctx.key,
    get: <T>(name: string) => ctx.get<T>(name),
    set: <T>(name: string, value: T) => {
      ctx.set<T>(name, value);
    },
    clear: (name: string) => {
      ctx.clear(name);
    },
    run: <T>(name: string, action: () => T | Promise<T>) => ctx.run<T>(name, async () => action()),
  };
}

export const steerObject = restate.object({
  name: STEER_SERVICE_NAME,
  handlers: {
    push: async (ctx: restate.ObjectContext, input: SteerPushInput): Promise<SteerPushResult> =>
      handlePush(adapt(ctx), input),
    drain: async (ctx: restate.ObjectContext): Promise<SteerMessage[]> => handleDrain(adapt(ctx)),
  },
});

export type SteerObject = typeof steerObject;

// ===========================================================================
// SteerSource adapter — satisfies @teaspill/harness-native's drain interface
// (interface.ts `SteerSource.drain(): Promise<SteerMessage[]>`) so pi-ai
// (0001:T3.2) and CASDK (0001:T7.2) can drain at their checkpoints.
// ===========================================================================

/**
 * HTTP-ingress-backed `SteerSource`. This is the transport a harness run
 * actually uses: `HarnessRunInput.steerSource` (0001:T3.1) is a plain object
 * handed INTO the harness, which calls `.drain()` from inside its own
 * `ctx.run` closure (agent.ts wraps the whole 0001:T2.1-stub harness run in one
 * `ctx.run("harness-run", ...)`; the step-durable native harness, 0001:T3.2,
 * will instead drain between per-step `ctx.run`s — either way, the harness
 * has no `restate.ObjectContext` of its own to make a typed SDK object call
 * with, only plain async I/O). A raw HTTP POST to the steerbox's Restate
 * ingress endpoint is therefore the right shape here — the same "network
 * call inside `ctx.run`" pattern `HttpTimelineStreamTransport`
 * (projection-outbox.ts) uses for the durable-streams server, and
 * "nondeterminism inside `ctx.run`" (0001:D2) is satisfied transitively because
 * the whole harness run this call happens inside of IS a `ctx.run`.
 *
 * Ingress path: `/steer/<percent-encoded-entityId>/drain` (0001:A4 f-2: keys are
 * arbitrary strings, including full urls, but MUST be percent-encoded in
 * raw ingress HTTP paths — the SDK's typed clients do this for you; this
 * hand-rolled transport must do it explicitly, which it does below).
 */
export interface HttpSteerSourceOptions {
  /** Restate ingress base url, e.g. `http://restate:8080`. */
  ingressUrl: string;
  /** Full canonical entity url — the steerbox key (docs/addressing.md §6). */
  entityId: string;
  fetch?: typeof fetch;
  /** Extra headers (e.g. auth) merged into the request. */
  headers?: Record<string, string>;
}

export function createHttpSteerSource(opts: HttpSteerSourceOptions): SteerSource {
  if (!opts.entityId) throw new Error("createHttpSteerSource: entityId must be non-empty");
  const base = opts.ingressUrl.replace(/\/$/, "");
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const path = `/${STEER_SERVICE_NAME}/${encodeURIComponent(opts.entityId)}/drain`;

  return {
    async drain(): Promise<SteerMessage[]> {
      const res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { ...opts.headers, "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`steer drain for ${JSON.stringify(opts.entityId)} failed: ${res.status} ${body}`);
      }
      return (await res.json()) as SteerMessage[];
    },
  };
}

// Note: a no-op `SteerSource` (nothing ever queued) already exists as
// `emptySteerSource` in ./agent-seams.js (0001:T2.1's config default) — not
// redefined here to avoid a duplicate-export collision on the package
// barrel; use that one.

// ===========================================================================
// Wake-start drain, no-loss contract (PLAN 0001:T2.6 anticipate)
//
// "The race where a steer lands just as the run ends must lose no
// messages: agents also drain the steerbox at wake start, so a missed steer
// becomes the first input of the next wake."
//
// Sequence this closes: (1) a run is in flight, mid-run drains see nothing
// new; (2) the run finishes and the agent object sets status back to
// `idle`+clears `currentInvocationId` (agent.ts `runWake`, AFTER the
// harness's own drains have already happened); (3) a `push` lands in this
// exact gap — after the harness stopped draining, before the NEXT wake
// starts; (4) that message would be silently stranded in the steerbox
// forever UNLESS the agent unconditionally drains again at the very start
// of handling its next wake, before recording that wake's own trigger
// input. `drainAtWakeStart` is that unconditional drain, rendered straight
// to canonical `message` event inits so the caller can prepend them to
// `preEvents` ahead of the wake's own message.
// ===========================================================================

/**
 * Render drained steer messages as canonical `message` event inits (role
 * `"user"`), in the SAME field shape `agent.ts`'s `runWake` already uses for
 * wake-input messages (`id`, `role`, `content`, `from?`) — see e.g.
 * `handleMessage`'s plain-message branch. Pure; no I/O.
 */
export function renderSteerMessagesAsEvents(messages: readonly SteerMessage[]): TimelineEventInit[] {
  return messages.map((m) => ({
    type: "message",
    ts: m.ts,
    payload: {
      id: m.id,
      role: "user",
      content: m.content,
      ...(m.from !== undefined && { from: m.from }),
    },
  }));
}

/**
 * The wake-start drain helper the agent object should call. NOT wired into
 * `agent.ts` by this task (0001:T2.6 scope is this file only — see module
 * header). Wire-in sketch for `agent.ts`'s `runWake` (left to 0001:T2.5/0001:T6.1,
 * whichever next touches agent.ts), added right before `preEvents` is
 * assembled for BOTH `handleSpawn` and `handleMessage`:
 *
 * ```ts
 * const steered = await drainAtWakeStart(steerSourceFor(entityId)); // one call, wake-start only
 * const preEvents = [...steered, ...originalPreEvents];
 * ```
 *
 * Draining unconditionally on every wake (not just steer-triggered ones) is
 * deliberate: it is the only way to guarantee the race window above can
 * never strand a message — a wake triggered by an ordinary `message` still
 * picks up anything that piled into the steerbox since the entity went
 * idle.
 */
export async function drainAtWakeStart(source: SteerSource): Promise<TimelineEventInit[]> {
  const messages = await source.drain();
  return renderSteerMessagesAsEvents(messages);
}

// ===========================================================================
// Mid-run vs idle routing (PLAN 0001:T2.6: "the gateway routes send(mode=steer)
// here when the target is mid-run, else falls through to a normal message
// wake"). Pure decision function — the caller performs the actual status
// read (see module header "Cheap status read") and the actual push/send.
// ===========================================================================

export type SteerRouteDecision =
  | { route: "steer"; target: { service: typeof STEER_SERVICE_NAME; key: string } }
  | { route: "message"; delivery: AgentMessageInput };

/**
 * Decide where a `send(mode=steer)` should land, given an already-read
 * status (module header: recommended source is the agent object's shared
 * status read, NOT the catalog — 0001:D1). `"active"` (an exclusive wake is
 * currently in flight, `agent.ts`'s `AGENT_KV.status`) routes to the
 * steerbox; anything else — `"idle"`, `"archived"`, or `null` (never
 * spawned / status unreadable) — degrades to an ordinary message wake with
 * `source: "steer_degraded"` (the canonical `WakeSource` enum already
 * reserves this value, `@teaspill/schema` events.ts, frozen at 0001:A5), per 0001:D2
 * "idle entity → steer degrades to a normal message wake."
 */
export function decideSteerRoute(
  entityId: string,
  status: EntityStatus | null,
  input: { content: ContentBlock[]; from?: string },
): SteerRouteDecision {
  if (status === "active") {
    return { route: "steer", target: steerTarget(entityId) };
  }
  return {
    route: "message",
    delivery: {
      kind: "message",
      content: input.content,
      ...(input.from !== undefined && { from: input.from }),
      source: "steer_degraded",
    },
  };
}
