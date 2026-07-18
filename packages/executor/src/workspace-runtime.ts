/**
 * Workspace virtual object — runtime context seam + K/V layout (0001:T4.1).
 *
 * Same structure as `packages/coordination/src/agent-runtime.ts` (the
 * established pattern this package mirrors so the two feel like one system):
 * handler LOGIC is written against small structural context interfaces so it
 * unit-tests against in-memory fakes; the real `restate.object` wiring in
 * ./workspace.ts is a thin adapter with no independent logic. What fakes
 * cannot cover — real awakeable resolution through the server, real
 * `ctx.cancel` + `explicitCancellation` semantics, replay of a crashed
 * dispatch step — is deferred to the live conformance/failure suites
 * (0001:T6.3/0001:T9.1), exactly as SPIKE-RESTATE.md prescribes.
 */

import * as restate from "@restatedev/restate-sdk";
import type { WorkspaceEnsureConfig } from "./adapter.js";

// ---------------------------------------------------------------------------
// K/V layout
// ---------------------------------------------------------------------------

/**
 * Complete K/V layout of a `workspace/<key>` object. Deliberately tiny: the
 * ENVIRONMENT state lives on the host/adapter side (0001:D4); the object holds
 * only what coordination needs.
 */
export const WORKSPACE_KV = {
  /**
   * `WorkspaceEnsureConfig` — the environment identity chosen at `ensure`
   * (0001:D4: chosen once, never switched; a re-`ensure` naming a different
   * adapter is a terminal error). Carried on every host call so a
   * cold-started host lazily re-ensures. Absent ⇒ never ensured (or
   * disposed).
   */
  config: "config",
  /** `"ready" | "disposed"` — object lifecycle. Absent ⇒ never ensured. */
  status: "status",
  /**
   * `string` — Restate invocation id of the exclusive handler currently in
   * flight (the escape hatch's cancel target, 0001:A4). Set at wake start,
   * cleared in `finally`; the shared `kill` handler reads it LIVE
   * (SPIKE §a-2) when `force` is requested.
   */
  currentInvocationId: "currentInvocationId",
  /**
   * `CurrentExecInfo` — the exec currently being awaited by the exclusive
   * `exec` handler. Written before dispatch and visible live to the shared
   * `kill`/`status` handlers, so a stuck exec can be identified and killed
   * WITHOUT queueing behind it (anticipate-a). Cleared when the exec wake
   * finishes.
   */
  currentExec: "currentExec",
} as const;

export interface CurrentExecInfo {
  execId: string;
  command: string;
  streamPath: string;
  startedTs: string;
}

export type WorkspaceStatus = "ready" | "disposed";

export type { WorkspaceEnsureConfig };

// ---------------------------------------------------------------------------
// Errors (the two ways an awaited exec can end early)
// ---------------------------------------------------------------------------

/**
 * The awakeable-level timeout fired (host dead/unreachable — the adapter's
 * own `timeoutMs` normally completes the exec first with `timedOut: true`).
 * Terminal: retrying the invocation cannot revive a dead host's exec.
 */
export class WorkspaceExecTimeoutError extends restate.TerminalError {
  constructor(message = "exec awakeable timed out") {
    super(message, { errorCode: 408 });
    this.name = "WorkspaceExecTimeoutError";
  }
}

/**
 * The in-flight invocation was cancelled (shared `kill --force`, or an
 * operator `ctx.cancel`). With `explicitCancellation: true` (0001:A4) the handler
 * catches this and still performs durable cleanup (host kill) before
 * completing — the workspace stays immediately usable.
 */
export class WorkspaceInterruptedError extends restate.TerminalError {
  constructor(message = "workspace invocation interrupted") {
    super(message, { errorCode: 409 });
    this.name = "WorkspaceInterruptedError";
  }
}

// ---------------------------------------------------------------------------
// Runtime contexts (structural subsets of the Restate contexts + 0001:A4 seams)
// ---------------------------------------------------------------------------

/** A durable awakeable: `id` is journaled (stable across retry attempts, SPIKE §d-4). */
export interface WorkspaceAwakeable<T> {
  readonly id: string;
  readonly promise: Promise<T>;
}

/**
 * The call surface host-client implementations need — present on BOTH the
 * exclusive and shared contexts (the shared `kill` handler must reach the
 * host too; `ObjectSharedContext` supports `run`/`genericCall`, it only
 * forbids state writes).
 */
export interface WorkspaceCallCtx {
  /** Durable side-effect step (at-least-once body, exactly-once result). */
  run<T>(name: string, action: () => T | Promise<T>): Promise<T>;
  /** Journaled Restate service call (exactly-once recorded result). */
  genericCall<REQ, RES>(call: {
    service: string;
    method: string;
    key?: string;
    parameter: REQ;
  }): Promise<RES>;
}

/** Subset of `restate.ObjectContext` (+ 0001:A4 seams) the exclusive workspace handlers use. */
export interface WorkspaceRuntimeCtx extends WorkspaceCallCtx {
  /** Object key = the workspace key `<tenant>/<name>` (0001:A3). */
  readonly key: string;
  /** `ctx.request().id` — replay-stable; recorded as the escape hatch's cancel target and used to derive `execId`. */
  readonly invocationId: string;
  get<T>(name: string): Promise<T | null>;
  set<T>(name: string, value: T): void;
  clear(name: string): void;
  /** Create a durable awakeable (SPIKE §d): survives endpoint restart; late/double resolve ignored. */
  awakeable<T>(): WorkspaceAwakeable<T>;
  /**
   * Await an awakeable raced against BOTH the hard timeout and the
   * invocation-cancellation (the SPIKE §d + §a patterns fused in one seam):
   * throws `WorkspaceExecTimeoutError` when `timeoutMs` elapses first, and
   * `WorkspaceInterruptedError` when the invocation is cancelled (shared
   * `kill --force` / operator cancel). Durable steps still work after either
   * throw — the object registers `explicitCancellation: true` (0001:A4).
   */
  awaitAwakeable<T>(awakeable: WorkspaceAwakeable<T>, timeoutMs: number): Promise<T>;
}

/**
 * Subset of `restate.ObjectSharedContext` the shared `kill`/`status` handlers
 * use: read K/V live, call the host (via `WorkspaceCallCtx`), cancel the
 * in-flight exclusive invocation — never write state (the design boundary
 * shared handlers inherit, same as the agent object's `signal`).
 */
export interface WorkspaceSharedRuntimeCtx extends WorkspaceCallCtx {
  readonly key: string;
  get<T>(name: string): Promise<T | null>;
  /** `ctx.cancel(invocationId)` — cancel-of-completed is a harmless 409 (SPIKE §a-3). */
  cancelInvocation(invocationId: string): void;
}
