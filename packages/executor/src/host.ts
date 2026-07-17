/**
 * Executor host (T4.1) — the service that OWNS the real environments (D4's
 * executor plane). The `workspace/<key>` virtual object (./workspace.ts) is
 * pure coordination: it delegates every effect here and holds no environment
 * state beyond its K/V config.
 *
 * ## Split of responsibilities
 *
 * - `ExecutorHost` (this class) — plain, Restate-free logic: environment
 *   registry (lazy `ensure`, recoverable from the per-call config after a
 *   host restart), exec lifecycle (spawn via adapter, stream chunks to the
 *   sink, resolve the caller's awakeable on completion), kill, FS dispatch.
 *   Unit-testable directly.
 * - `createExecutorHostService` — the thin Restate *service* wrapper (a
 *   plain stateless service, NOT a virtual object: serialization lives at
 *   the workspace object; the host must serve `killExec` for workspace A
 *   while workspace B's exec dispatch is in flight). Registered as its own
 *   deployment (or co-located on the executor endpoint, ./endpoint.ts).
 *
 * ## The long-exec protocol (D4/R4, SPIKE §d)
 *
 * `startExec` returns IMMEDIATELY after spawning; the process runs in this
 * host process, detached from any Restate invocation. On completion the host
 * resolves the workspace object's awakeable (via Restate ingress HTTP —
 * `POST /restate/awakeables/{id}/resolve`; late/duplicate resolutions are
 * accepted-and-ignored server-side, SPIKE §d-3, so the host never needs to
 * know whether the waiter timed out). stdout/stderr chunks go out-of-band to
 * the durable stream through the sink seam — never through Restate.
 *
 * ## Idempotence (the at-least-once edge)
 *
 * The workspace object's dispatch step is at-least-once (A4 §3), so
 * `startExec` DEDUPES on `(workspaceKey, execId)`: re-dispatch of a known
 * exec — running or completed — is a no-op (a completed one re-resolves the
 * awakeable, which is safe). Completed exec records are retained bounded
 * (`maxCompletedExecs`, default 256, FIFO eviction) — ample, since dedup only
 * matters within one invocation's retry horizon.
 *
 * If the HOST dies mid-exec, the exec dies with it and the awakeable never
 * resolves — the workspace object's awakeable timeout (its backstop, D4
 * anticipate-a) converts that into a visible exec failure. Verified live in
 * T9.1 ("kill executor mid-exec → awakeable timeout → error event,
 * workspace recoverable").
 */

import * as restate from "@restatedev/restate-sdk";
import type {
  DirEntry,
  ExecCompletion,
  ExecHandle,
  ExecutorAdapter,
  FileStat,
  ReadResult,
  WorkspaceEnsureConfig,
  WorkspaceEnv,
} from "./adapter.js";
import { WorkspaceError, toWorkspaceErrorShape, type WorkspaceErrorShape } from "./errors.js";
import { noopStreamSink, type WorkspaceStreamSink } from "./stream-sink.js";
import { NOOP_EXECUTOR_METRICS, type ExecutorMetrics } from "./otel.js";

// ---------------------------------------------------------------------------
// Wire types (workspace object ⇄ host)
// ---------------------------------------------------------------------------

/** Carried on every host call so a cold-started host can lazily re-`ensure` (identity from key+config alone). */
export interface HostWorkspaceRef {
  workspaceKey: string;
  config: WorkspaceEnsureConfig;
}

export interface HostEnsureResult {
  adapter: string;
  workingDirectory: string;
  readContainment: "workspace" | "environment";
}

export interface HostStartExecRequest {
  ref: HostWorkspaceRef;
  execId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  /** Adapter-enforced hard timeout (the workspace object adds its awakeable backstop on top). */
  timeoutMs: number;
  maxTailBytes: number;
  /** Awakeable to resolve with `ExecCompletion` when the exec finishes. */
  awakeableId: string;
  /** Per-exec durable stream path for out-of-band stdout/stderr. */
  streamPath: string;
}

export interface HostStartExecResult {
  accepted: true;
  /** True when this dispatch was an idempotent re-dispatch of a known execId. */
  deduped: boolean;
}

export interface HostKillExecRequest {
  ref: HostWorkspaceRef;
  execId: string;
}

export interface HostKillExecResult {
  /** True iff a running exec was found and signalled. */
  killed: boolean;
  state: "running" | "completed" | "unknown";
}

export type HostFsOp =
  | { op: "read"; path: string; maxBytes?: number }
  | { op: "write"; path: string; content: string; encoding?: "utf8" | "base64" }
  | { op: "mkdir"; path: string; recursive?: boolean }
  | { op: "rm"; path: string; recursive?: boolean }
  | { op: "stat"; path: string }
  | { op: "ls"; path: string };

export type HostFsRequest = { ref: HostWorkspaceRef } & HostFsOp;

export type HostFsResult =
  | { op: "read"; ok: true; result: ReadResult }
  | { op: "write"; ok: true }
  | { op: "mkdir"; ok: true }
  | { op: "rm"; ok: true }
  | { op: "stat"; ok: true; result: FileStat }
  | { op: "ls"; ok: true; result: DirEntry[] }
  | { ok: false; error: WorkspaceErrorShape };

export interface HostDisposeRequest {
  ref: HostWorkspaceRef;
  /** Destroy persisted state (dir/volume); default preserves for reattach. */
  wipe?: boolean;
}

// ---------------------------------------------------------------------------
// Awakeable resolver seam
// ---------------------------------------------------------------------------

/**
 * How the host completes the workspace object's awakeable. The real
 * implementation posts to Restate ingress; tests inject a fake. Resolution
 * failures are retried a few times, then dropped — the workspace's awakeable
 * timeout is the correctness backstop (never the resolver).
 */
export type AwakeableResolver = (awakeableId: string, payload: ExecCompletion) => Promise<void>;

export interface IngressResolverOptions {
  /**
   * Restate ingress base URL AS SEEN FROM THE HOST PROCESS. Networking stance
   * per docs/self-hosting-networking.md: a host running on the dev machine
   * reaches the compose-published ingress at `http://localhost:8080`; a host
   * running as a compose service uses `http://restate:8080`. (The inverse
   * direction — Restate dialing this host's registered deployment URL — is
   * where `host.docker.internal` applies; see §3 there and this package's
   * README.)
   */
  ingressUrl: string;
  fetchImpl?: typeof fetch;
}

/** Real resolver: `POST {ingress}/restate/awakeables/{id}/resolve` (SPIKE §d). */
export function createIngressAwakeableResolver(opts: IngressResolverOptions): AwakeableResolver {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.ingressUrl.replace(/\/$/, "");
  return async (awakeableId, payload) => {
    const res = await f(`${base}/restate/awakeables/${encodeURIComponent(awakeableId)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // 2xx incl. the 202 late/duplicate-resolve case (SPIKE §d-3). Anything
    // else is a transport/server error worth retrying.
    if (!res.ok) {
      throw new Error(`awakeable resolve failed: HTTP ${res.status}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Host core
// ---------------------------------------------------------------------------

export interface ExecutorHostOptions {
  /** Adapter registry by name (`local` here; `docker`/`local-unrestricted` in T4.2). */
  adapters: Record<string, ExecutorAdapter>;
  /** Out-of-band stdout sink. Default: drop (noop) — see stream-sink.ts version note. */
  streamSink?: WorkspaceStreamSink;
  resolveAwakeable: AwakeableResolver;
  /** Retries for awakeable resolution before giving up (backstop = waiter timeout). */
  resolveRetries?: number;
  resolveRetryDelayMs?: number;
  /** Completed-exec records retained per host for dedup (FIFO evicted). */
  maxCompletedExecs?: number;
  /**
   * Observability recorder (T8.2). Default no-op. Records the `workspace_pool`
   * gauge (active workspaces + in-flight execs on this host) at every pool
   * mutation — ensure, exec dispatch, exec completion, dispose. The host is the
   * fleet point for this gauge (D4: environments live on the host, the
   * workspace object holds only coordination K/V).
   */
  metrics?: ExecutorMetrics;
}

interface ExecRecord {
  execId: string;
  workspaceKey: string;
  handle: ExecHandle;
  state: "running" | "completed";
  completion?: ExecCompletion;
  awakeableId: string;
}

export class ExecutorHost {
  private readonly envs = new Map<string, Promise<WorkspaceEnv>>();
  private readonly execs = new Map<string, ExecRecord>(); // key: `${workspaceKey}\n${execId}`
  private readonly completedOrder: string[] = [];
  private readonly sink: WorkspaceStreamSink;
  private readonly resolveRetries: number;
  private readonly resolveRetryDelayMs: number;
  private readonly maxCompletedExecs: number;
  private readonly metrics: ExecutorMetrics;

  constructor(private readonly opts: ExecutorHostOptions) {
    this.sink = opts.streamSink ?? noopStreamSink;
    this.resolveRetries = opts.resolveRetries ?? 3;
    this.resolveRetryDelayMs = opts.resolveRetryDelayMs ?? 1000;
    this.maxCompletedExecs = opts.maxCompletedExecs ?? 256;
    this.metrics = opts.metrics ?? NOOP_EXECUTOR_METRICS;
  }

  /** T8.2 `workspace_pool` sample: active workspaces + currently-running execs. */
  private recordPool(): void {
    let runningExecs = 0;
    for (const record of this.execs.values()) {
      if (record.state === "running") runningExecs += 1;
    }
    this.metrics.recordWorkspacePool({ activeWorkspaces: this.envs.size, runningExecs });
  }

  async ensure(ref: HostWorkspaceRef): Promise<HostEnsureResult> {
    const adapter = this.adapterFor(ref.config);
    const env = await this.envFor(ref);
    this.recordPool();
    return {
      adapter: adapter.name,
      workingDirectory: env.workingDirectory,
      readContainment: adapter.readContainment,
    };
  }

  async startExec(req: HostStartExecRequest): Promise<HostStartExecResult> {
    const key = execKey(req.ref.workspaceKey, req.execId);
    const existing = this.execs.get(key);
    if (existing) {
      // Idempotent re-dispatch (at-least-once upstream step). A completed
      // record re-resolves the awakeable — harmless (late resolve ignored)
      // and heals the crashed-between-resolve-and-journal window.
      if (existing.state === "completed" && existing.completion) {
        void this.resolveWithRetry(existing.awakeableId, existing.completion);
      }
      return { accepted: true, deduped: true };
    }

    const env = await this.envFor(req.ref);
    await this.sink.ensureStream(req.streamPath);
    const handle = env.startExec({
      execId: req.execId,
      command: req.command,
      ...(req.cwd !== undefined && { cwd: req.cwd }),
      ...(req.env !== undefined && { env: req.env }),
      ...(req.stdin !== undefined && { stdin: req.stdin }),
      timeoutMs: req.timeoutMs,
      maxTailBytes: req.maxTailBytes,
      onChunk: (chunk) => this.sink.append(req.streamPath, chunk),
    });
    const record: ExecRecord = {
      execId: req.execId,
      workspaceKey: req.ref.workspaceKey,
      handle,
      state: "running",
      awakeableId: req.awakeableId,
    };
    this.execs.set(key, record);
    this.recordPool();

    void handle.wait().then((completion) => {
      record.state = "completed";
      record.completion = completion;
      this.completedOrder.push(key);
      while (this.completedOrder.length > this.maxCompletedExecs) {
        const evict = this.completedOrder.shift();
        if (evict !== undefined) this.execs.delete(evict);
      }
      this.recordPool();
      return this.resolveWithRetry(req.awakeableId, completion);
    });

    return { accepted: true, deduped: false };
  }

  /**
   * Kill an exec's process tree (the escape-hatch target, anticipate-a).
   * Killing an unknown/completed exec is a safe no-op — the caller races
   * with natural completion by design.
   */
  async killExec(req: HostKillExecRequest): Promise<HostKillExecResult> {
    const record = this.execs.get(execKey(req.ref.workspaceKey, req.execId));
    if (!record) return { killed: false, state: "unknown" };
    if (record.state === "completed") return { killed: false, state: "completed" };
    record.handle.kill();
    return { killed: true, state: "running" };
  }

  async fs(req: HostFsRequest): Promise<HostFsResult> {
    try {
      const env = await this.envFor(req.ref);
      switch (req.op) {
        case "read":
          return {
            op: "read",
            ok: true,
            result: await env.readFile(
              req.path,
              req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : undefined,
            ),
          };
        case "write":
          await env.writeFile(
            req.path,
            req.content,
            req.encoding !== undefined ? { encoding: req.encoding } : undefined,
          );
          return { op: "write", ok: true };
        case "mkdir":
          await env.mkdir(req.path, { recursive: req.recursive ?? false });
          return { op: "mkdir", ok: true };
        case "rm":
          await env.rm(req.path, { recursive: req.recursive ?? false });
          return { op: "rm", ok: true };
        case "stat":
          return { op: "stat", ok: true, result: await env.stat(req.path) };
        case "ls":
          return { op: "ls", ok: true, result: await env.ls(req.path) };
      }
    } catch (err) {
      // Policy/runtime failures are DATA to the workspace object (it decides
      // terminal-vs-retry), not transport errors.
      return { ok: false, error: toWorkspaceErrorShape(err) };
    }
  }

  async dispose(req: HostDisposeRequest): Promise<void> {
    const envPromise = this.envs.get(req.ref.workspaceKey);
    const env = envPromise ? await envPromise : await this.envFor(req.ref);
    // Kill any running execs for this workspace first.
    for (const record of this.execs.values()) {
      if (record.workspaceKey === req.ref.workspaceKey && record.state === "running") {
        record.handle.kill();
      }
    }
    await env.dispose(req.wipe !== undefined ? { wipe: req.wipe } : undefined);
    this.envs.delete(req.ref.workspaceKey);
    this.recordPool();
  }

  private adapterFor(config: WorkspaceEnsureConfig): ExecutorAdapter {
    const adapter = this.opts.adapters[config.adapter];
    if (!adapter) {
      throw new WorkspaceError(
        "unavailable",
        `no adapter named ${JSON.stringify(config.adapter)} registered on this executor host ` +
          `(available: ${Object.keys(this.opts.adapters).join(", ") || "none"})`,
      );
    }
    return adapter;
  }

  /** Lazy get-or-ensure — the host-restart recovery path (identity from key+config alone). */
  private envFor(ref: HostWorkspaceRef): Promise<WorkspaceEnv> {
    let env = this.envs.get(ref.workspaceKey);
    if (!env) {
      env = this.adapterFor(ref.config).ensure({
        workspaceKey: ref.workspaceKey,
        config: ref.config,
      });
      env.catch(() => this.envs.delete(ref.workspaceKey)); // don't cache a failed ensure
      this.envs.set(ref.workspaceKey, env);
    }
    return env;
  }

  private async resolveWithRetry(awakeableId: string, completion: ExecCompletion): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.opts.resolveAwakeable(awakeableId, completion);
        return;
      } catch {
        if (attempt >= this.resolveRetries) return; // give up — waiter timeout is the backstop
        await new Promise((r) => setTimeout(r, this.resolveRetryDelayMs * (attempt + 1)));
      }
    }
  }
}

function execKey(workspaceKey: string, execId: string): string {
  return `${workspaceKey}\n${execId}`;
}

// ---------------------------------------------------------------------------
// Restate service wiring
// ---------------------------------------------------------------------------

export const EXECUTOR_HOST_SERVICE_NAME = "executor-host";

/**
 * The registered-deployment surface (D4). A plain stateless Restate service:
 * per-workspace serialization is the WORKSPACE OBJECT's job; the host must
 * stay concurrently callable (a `killExec` must never queue behind a long
 * dispatch — that is the whole point of the escape hatch).
 *
 * Handler bodies are single-step effects (no `ctx.run` choreography): each
 * is at-least-once under retry and made safe by the host's execId dedup /
 * idempotent ensure/kill semantics.
 */
export function createExecutorHostService(host: ExecutorHost) {
  return restate.service({
    name: EXECUTOR_HOST_SERVICE_NAME,
    handlers: {
      ensure: async (_ctx: restate.Context, ref: HostWorkspaceRef): Promise<HostEnsureResult> =>
        wrapHostErrors(() => host.ensure(ref)),
      startExec: async (
        _ctx: restate.Context,
        req: HostStartExecRequest,
      ): Promise<HostStartExecResult> => wrapHostErrors(() => host.startExec(req)),
      killExec: async (
        _ctx: restate.Context,
        req: HostKillExecRequest,
      ): Promise<HostKillExecResult> => wrapHostErrors(() => host.killExec(req)),
      fs: async (_ctx: restate.Context, req: HostFsRequest): Promise<HostFsResult> => host.fs(req),
      dispose: async (_ctx: restate.Context, req: HostDisposeRequest): Promise<void> =>
        wrapHostErrors(() => host.dispose(req)),
    },
  });
}

/** Policy/unavailable errors are terminal (retrying cannot fix them); runtime errors stay retryable. */
async function wrapHostErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkspaceError && err.kind !== "runtime") {
      throw new restate.TerminalError(`[${err.kind}] ${err.message}`);
    }
    throw err;
  }
}

export type ExecutorHostService = ReturnType<typeof createExecutorHostService>;
