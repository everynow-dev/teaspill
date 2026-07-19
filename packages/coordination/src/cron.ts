/**
 * `cron/<key>` — 0001:T2.4: a tiny self-rescheduling Restate virtual object.
 *
 * Implements 0001:D2 ("Delayed sends replace the scheduler; cron = a tiny
 * self-rescheduling object") and the Restate naming from docs/addressing.md
 * §6/§9 — service `cron`, key `<name>` (0001:A3-confirmed: dots/slashes in
 * service names and arbitrary-string keys both work on Restate 1.7.2 /
 * SDK 1.16.2, per SPIKE-RESTATE.md §f).
 *
 * ## Shape
 *
 * - `schedule(spec)` — set or replace the cron's schedule. Bumps a
 *   generation counter, stores the spec, computes the first fire time, and
 *   issues one delayed self-send of `tick()`.
 * - `unschedule()` — clears the spec and bumps the generation counter. This
 *   is the ONLY cancellation mechanism (Restate delayed sends can't be
 *   individually revoked by key) — see "The generation-guard footgun" below.
 * - `tick()` — internal. On every tick: (1) one-way-sends the target
 *   payload, (2) computes the next fire time from the cron expression +
 *   timezone, (3) issues the next delayed self-send. Guarded by the
 *   generation counter so a stale tick from a superseded schedule chain is a
 *   no-op.
 *
 * ## The generation-guard footgun
 *
 * A self-rescheduling object's classic bug: `tick()` fires the target *and
 * then* schedules its own successor. If `unschedule()` (or a replacing
 * `schedule()`) runs strictly between those two steps of some OTHER already
 * in-flight tick, the in-flight tick's delayed self-send was already
 * durably queued before the cancellation happened — Restate has no API to
 * revoke a specific delayed send by content, only by invocation id, which
 * the canceller doesn't have. Left unguarded, that queued tick eventually
 * fires anyway, "resurrecting" a cron the caller believed was stopped.
 *
 * The fix: every mutation of the schedule (`schedule` or `unschedule`)
 * bumps a monotonic `generation` counter stored alongside `spec` in K/V,
 * atomically (single-writer per key, 0001:D2). Every `tick()` message carries
 * the generation it was minted under. `tick()` compares its message
 * generation against the current K/V generation *before* doing anything
 * observable; on mismatch it is a pure no-op — no target send, no
 * reschedule. The tick chain simply dies. See `cron.test.ts` §"generation
 * guard" for the scenario spelled out end to end.
 *
 * ## Replay-safe "now"
 *
 * 0001:D2: "All nondeterminism (LLM calls, HTTP, clock) inside `ctx.run`." Both
 * `schedule()` and `tick()` read wall-clock time exactly once, via
 * `ctx.run("now", () => Date.now())` (SPIKE-RESTATE.md pattern) — never a
 * naked `Date.now()` in handler body. `nextFireAfter` itself is a pure
 * function of `(afterMs, expression, timezone)` with no clock access at
 * all, so it is trivially replay-safe and directly unit-testable (see
 * cron.test.ts) without a live Restate server.
 *
 * Design choice: each tick recomputes "next fire after **now**" (not "next
 * fire after the previously scheduled time"). This is the boring, standard
 * cron behavior — a tick that runs very late (e.g. after downtime) does not
 * fire a backlog of missed occurrences; it just resumes on the true
 * wall-clock grid. `TickMessage.scheduledFor` is carried along purely for
 * introspection/logging/tests, not consulted by the guard or the
 * next-fire computation.
 *
 * ## Cron library choice: croner
 *
 * `croner` (MIT, zero runtime dependencies, `node >= 18`) over `cron-parser`
 * (which pulls in `luxon` for timezone support). Croner resolves cron
 * fields against IANA timezone data via the platform `Intl` API, so DST
 * transitions (spring-forward gaps, fall-back ambiguous hours) are handled
 * by the same tz database the rest of the JS ecosystem trusts — no hand-
 * rolled offset math, which is exactly the "boring path" 0001:T2.4 asks for.
 * `job.nextRun(afterDate)` gives the "next fire strictly after a given
 * instant" primitive this module is built on directly, with no timer/side
 * effects created by constructing a `Cron` instance without a callback.
 *
 * ## What's pure vs what needs a live Restate runtime
 *
 * - `nextFireAfter` and `assertValidCronSpec` are pure functions — unit
 *   tested directly, no Restate runtime involved.
 * - `handleSchedule` / `handleUnschedule` / `handleTick` are the handler
 *   *logic*, written against the small `CronRuntimeCtx` interface (a
 *   structural subset of `restate.ObjectContext` — get/set/clear/run/
 *   genericSend/key). They are unit tested against an in-memory fake
 *   implementing that interface (see cron.test.ts), which is enough to
 *   exercise the generation-guard scenario deterministically and fast.
 *   What this does NOT cover: real Restate delivery guarantees (delayed
 *   sends actually arriving after the requested delay, exactly-once
 *   dedup, replay of a crashed `ctx.run`, `explicitCancellation`
 *   interaction). Those need a live server (SPIKE-RESTATE.md's spike
 *   harness) and are left as a conformance-kit item (0001:T6.3), consistent
 *   with how 0001:T2.0's own findings were verified.
 * - `cronObject` (the actual `restate.object(...)` registration) is a thin
 *   adapter with no independent logic — not separately tested here.
 */

import * as restate from "@restatedev/restate-sdk";
import { Cron } from "croner";

/** Restate service name for the cron object (docs/addressing.md §6/§9). */
export const CRON_SERVICE_NAME = "cron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a tick's payload gets sent — an arbitrary Restate virtual object handler. */
export interface CronTarget {
  service: string;
  key: string;
  handler: string;
}

/** The `schedule(spec)` request body; also what's persisted in K/V. */
export interface CronSpec {
  /** A standard 5- or 6-field cron expression (croner syntax; seconds field optional). */
  expression: string;
  /** IANA timezone name, e.g. "America/New_York". Required — no implicit UTC-only mode. */
  timezone: string;
  target: CronTarget;
  /** Opaque payload delivered verbatim to `target.handler` on every tick. */
  payload: unknown;
}

interface TickMessage {
  /** The generation this tick chain was minted under — the guard's key input. */
  generation: number;
  /** Epoch ms this tick was scheduled to fire at. Informational only (see header). */
  scheduledFor: number;
}

export interface ScheduleResult {
  generation: number;
  nextFireAt: number;
}

export interface UnscheduleResult {
  generation: number;
  wasScheduled: boolean;
}

export type TickResult =
  | { fired: true; nextFireAt: number }
  | { fired: false; reason: "stale-generation" | "no-spec" };

// ---------------------------------------------------------------------------
// Pure next-fire computation — no clock access, no Restate context.
// ---------------------------------------------------------------------------

/**
 * The next fire time strictly after `afterMs`, honoring `timezone`. Pure and
 * deterministic for a given `(expression, timezone, afterMs)` triple.
 */
export function nextFireAfter(afterMs: number, expression: string, timezone: string): number {
  const job = new Cron(expression, { timezone });
  const next = job.nextRun(new Date(afterMs));
  if (next === null) {
    throw new restate.TerminalError(
      `cron expression ${JSON.stringify(expression)} has no future fire time after ` +
        `${new Date(afterMs).toISOString()}`,
    );
  }
  return next.getTime();
}

/** Throws a `TerminalError` if the expression or timezone is not parseable. */
export function assertValidCronSpec(spec: CronSpec): void {
  try {
    const job = new Cron(spec.expression, { timezone: spec.timezone });
    // croner validates the *expression* at construction but resolves the
    // *timezone* lazily, only when a date is actually computed (verified:
    // `new Cron(expr, { timezone: "Not/AZone" })` does not throw, but the
    // first `nextRun()` does). Force that resolution now, against a fixed
    // reference instant (epoch 0 — never `Date.now()`; this is validation,
    // not scheduling, and must stay a pure function of its arguments) so an
    // invalid IANA name is rejected at `schedule()` time, not on first tick.
    job.nextRun(new Date(0));
  } catch (err) {
    throw new restate.TerminalError(
      `invalid cron spec (expression=${JSON.stringify(spec.expression)}, ` +
        `timezone=${JSON.stringify(spec.timezone)}): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Handler logic, against a minimal structural context (unit-testable without
// a live Restate server — see cron.test.ts).
// ---------------------------------------------------------------------------

/** The subset of `restate.ObjectContext` the cron handlers actually use. */
export interface CronRuntimeCtx {
  readonly key: string;
  get<T>(name: string): Promise<T | null>;
  set<T>(name: string, value: T): void;
  clear(name: string): void;
  run<T>(name: string, action: () => T | Promise<T>): Promise<T>;
  genericSend(call: {
    service: string;
    method: string;
    key?: string;
    parameter: unknown;
    delay?: number;
  }): void;
}

async function currentGeneration(ctx: CronRuntimeCtx): Promise<number> {
  return (await ctx.get<number>("generation")) ?? 0;
}

function sendTick(ctx: CronRuntimeCtx, generation: number, nextFireAt: number, delayMs: number): void {
  const msg: TickMessage = { generation, scheduledFor: nextFireAt };
  ctx.genericSend({
    service: CRON_SERVICE_NAME,
    method: "tick",
    key: ctx.key,
    parameter: msg,
    delay: Math.max(0, delayMs),
  });
}

export async function handleSchedule(ctx: CronRuntimeCtx, spec: CronSpec): Promise<ScheduleResult> {
  assertValidCronSpec(spec);

  // Bump generation FIRST, atomically with storing the new spec: this is
  // the operation that invalidates any tick chain from a prior schedule.
  const generation = (await currentGeneration(ctx)) + 1;
  ctx.set("generation", generation);
  ctx.set("spec", spec);

  const now = await ctx.run("now", () => Date.now());
  const nextFireAt = nextFireAfter(now, spec.expression, spec.timezone);
  ctx.set("nextFireAt", nextFireAt);

  sendTick(ctx, generation, nextFireAt, nextFireAt - now);

  return { generation, nextFireAt };
}

export async function handleUnschedule(ctx: CronRuntimeCtx): Promise<UnscheduleResult> {
  const spec = await ctx.get<CronSpec>("spec");
  const generation = (await currentGeneration(ctx)) + 1;
  // Bump generation and clear spec ATOMICALLY (same handler invocation,
  // single-writer per key) — this is what makes the generation-guard
  // correct: there is no window where generation is bumped but spec is
  // still present, or vice versa.
  ctx.set("generation", generation);
  ctx.clear("spec");
  ctx.clear("nextFireAt");
  return { generation, wasScheduled: spec !== null };
}

export async function handleTick(ctx: CronRuntimeCtx, msg: TickMessage): Promise<TickResult> {
  const generation = await currentGeneration(ctx);
  if (msg.generation !== generation) {
    // Stale tick from a chain that schedule()/unschedule() has since
    // superseded. Do NOT resurrect: no target send, no reschedule.
    return { fired: false, reason: "stale-generation" };
  }

  const spec = await ctx.get<CronSpec>("spec");
  if (!spec) {
    // Defensive only: generation matching with no spec should be
    // unreachable, since unschedule() bumps generation atomically with
    // clearing spec (see handleUnschedule). Treat as stale rather than
    // throw, so a theoretical race never resurrects a target send.
    return { fired: false, reason: "no-spec" };
  }

  // 1. Fire the target payload, one-way. Restate's send is durable once
  //    this invocation commits (0001:D2) — firing is not gated on step 2/3.
  ctx.genericSend({
    service: spec.target.service,
    method: spec.target.handler,
    key: spec.target.key,
    parameter: spec.payload,
  });

  // 2. Compute the next fire time from "now", not from the previously
  //    scheduled time — see header "Replay-safe now".
  const now = await ctx.run("now", () => Date.now());
  const nextFireAt = nextFireAfter(now, spec.expression, spec.timezone);
  ctx.set("nextFireAt", nextFireAt);

  // 3. Delayed self-send for the next tick, same generation.
  sendTick(ctx, msg.generation, nextFireAt, nextFireAt - now);

  return { fired: true, nextFireAt };
}

// ---------------------------------------------------------------------------
// Restate wiring — thin adapter from the real ObjectContext to CronRuntimeCtx.
// ---------------------------------------------------------------------------

function adapt(ctx: restate.ObjectContext): CronRuntimeCtx {
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
    genericSend: (call) => {
      // JSON serde required — the SDK defaults generic calls to serde.binary,
      // which delivers `undefined` to typed JSON handlers live (0002:T4.2).
      ctx.genericSend({ ...call, inputSerde: restate.serde.json as restate.Serde<unknown> });
    },
  };
}

/**
 * The `cron/<key>` virtual object. Handlers stay exclusive (default) —
 * unlike the agent object (0001:A4), cron handlers are short (K/V read/write +
 * one-way sends, no LLM/tool calls), so the `explicitCancellation` +
 * `ctx.cancellation()` interrupt seam 0001:A4 mandates for agent/workspace
 * objects is not load-bearing here: there is no long-running `ctx.run` for
 * an interrupt to race against, and nothing in 0001:T2.4's scope calls for
 * mid-tick cancellation (unscheduling is handled entirely by the
 * generation guard, not by aborting an in-flight tick).
 */
export const cronObject = restate.object({
  name: CRON_SERVICE_NAME,
  handlers: {
    schedule: async (ctx: restate.ObjectContext, spec: CronSpec): Promise<ScheduleResult> =>
      handleSchedule(adapt(ctx), spec),
    unschedule: async (ctx: restate.ObjectContext): Promise<UnscheduleResult> =>
      handleUnschedule(adapt(ctx)),
    tick: async (ctx: restate.ObjectContext, msg: TickMessage): Promise<TickResult> =>
      handleTick(adapt(ctx), msg),
  },
});

export type CronObject = typeof cronObject;
