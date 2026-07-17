/**
 * Workspace→host client seam (T4.1) — how the `workspace/<key>` object
 * reaches the executor host. Two implementations:
 *
 * - `createRestateHostClient()` — the REAL wiring: journaled Restate calls
 *   (`ctx.genericCall`) to the `executor-host` service. Exactly-once
 *   recorded results in the workspace object's journal; the host runs as its
 *   own registered deployment (or co-located on the same endpoint —
 *   networking stance in the README / docs/self-hosting-networking.md §4).
 * - `createDirectHostClient(host)` — in-process: wraps each host method in a
 *   `ctx.run` step. Used by tests and by single-process dev deployments
 *   where object and host share the endpoint. `ctx.run` bodies are
 *   at-least-once — safe because every host method is idempotent by design
 *   (execId dedup, get-or-ensure, kill-of-completed no-op).
 */

import type {
  HostDisposeRequest,
  HostEnsureResult,
  HostFsRequest,
  HostFsResult,
  HostKillExecRequest,
  HostKillExecResult,
  HostStartExecRequest,
  HostStartExecResult,
  HostWorkspaceRef,
} from "./host.js";
import { EXECUTOR_HOST_SERVICE_NAME, type ExecutorHost } from "./host.js";
import type { WorkspaceCallCtx } from "./workspace-runtime.js";

export interface WorkspaceHostClient {
  ensure(ctx: WorkspaceCallCtx, ref: HostWorkspaceRef): Promise<HostEnsureResult>;
  startExec(ctx: WorkspaceCallCtx, req: HostStartExecRequest): Promise<HostStartExecResult>;
  /** Callable from SHARED contexts too — the escape hatch depends on it. */
  killExec(ctx: WorkspaceCallCtx, req: HostKillExecRequest): Promise<HostKillExecResult>;
  fs(ctx: WorkspaceCallCtx, req: HostFsRequest): Promise<HostFsResult>;
  dispose(ctx: WorkspaceCallCtx, req: HostDisposeRequest): Promise<void>;
}

/** Journaled Restate calls to the registered `executor-host` deployment. */
export function createRestateHostClient(
  serviceName: string = EXECUTOR_HOST_SERVICE_NAME,
): WorkspaceHostClient {
  const call = <REQ, RES>(ctx: WorkspaceCallCtx, method: string, parameter: REQ): Promise<RES> =>
    ctx.genericCall<REQ, RES>({ service: serviceName, method, parameter });
  return {
    ensure: (ctx, ref) => call(ctx, "ensure", ref),
    startExec: (ctx, req) => call(ctx, "startExec", req),
    killExec: (ctx, req) => call(ctx, "killExec", req),
    fs: (ctx, req) => call(ctx, "fs", req),
    dispose: (ctx, req) => call(ctx, "dispose", req),
  };
}

/** In-process host behind `ctx.run` steps (tests / co-located dev deployments). */
export function createDirectHostClient(host: ExecutorHost): WorkspaceHostClient {
  return {
    ensure: (ctx, ref) => ctx.run("host-ensure", () => host.ensure(ref)),
    startExec: (ctx, req) => ctx.run("host-start-exec", () => host.startExec(req)),
    killExec: (ctx, req) => ctx.run("host-kill-exec", () => host.killExec(req)),
    fs: (ctx, req) => ctx.run("host-fs", () => host.fs(req)),
    dispose: (ctx, req) => ctx.run("host-dispose", () => host.dispose(req)),
  };
}
