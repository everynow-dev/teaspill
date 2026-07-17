/**
 * `workspace/<key>` — T4.1: the workspace virtual object (D4).
 *
 * Restate service `workspace`, key `<tenant>/<name>` (A3, addressing §6).
 * Exclusive handlers are SERIALIZED PER WORKSPACE BY CONSTRUCTION — the
 * single-writer property D4 wants — which also means a hung exec would block
 * the workspace; the three defenses (anticipate-a) are:
 *
 *   1. the ADAPTER's hard `timeoutMs` (kill-tree escalation on the host),
 *   2. the object's AWAKEABLE timeout backstop (`timeoutMs` + grace — fires
 *      only when the host itself is dead/unreachable, SPIKE §d pattern),
 *   3. the SHARED `kill` escape hatch: runs concurrently with the blocked
 *      exclusive `exec` (never queues behind it), reads the live
 *      `currentExec` K/V (SPIKE §a-2), tells the host to kill the process
 *      tree — the exec's awakeable then resolves with `killed: true` — and
 *      with `force: true` additionally `ctx.cancel`s the in-flight
 *      invocation (the workspace analogue of the agent object's shared
 *      `signal` seam).
 *
 * The object DELEGATES every environment effect to the executor host
 * (./host.ts) through the `WorkspaceHostClient` seam (./host-client.ts) and
 * holds only coordination state in K/V (./workspace-runtime.ts).
 *
 * Long-exec flow (D4/R4, SPIKE §d): create awakeable → journaled dispatch to
 * the host (returns immediately) → host streams stdout/stderr out-of-band to
 * the per-exec durable stream → host resolves the awakeable with the
 * completion → the awaited result is `{ exitCode, tailBytes, streamRef }`
 * (bulk output NEVER in the journal; tail is budget-capped).
 *
 * Handler naming: PLAN T4.1 writes the FS surface as `fs.{read,write,...}`;
 * the registered handler names are `fsRead`/`fsWrite`/… — T2.0 verified the
 * service-NAME grammar allows dots but did not verify handler names, so we
 * stay inside the known-safe charset. The gateway's `/api/*` map (T1.2 name
 * seam) is where the public spelling is decided.
 */

import * as restate from "@restatedev/restate-sdk";
import type {
  DirEntry,
  ExecCompletion,
  FileStat,
  ReadResult,
  WorkspaceEnsureConfig,
} from "./adapter.js";
import type { HostFsOp, HostFsResult, HostWorkspaceRef } from "./host.js";
import type { WorkspaceHostClient } from "./host-client.js";
import {
  WORKSPACE_KV,
  WorkspaceExecTimeoutError,
  WorkspaceInterruptedError,
  type CurrentExecInfo,
  type WorkspaceRuntimeCtx,
  type WorkspaceSharedRuntimeCtx,
  type WorkspaceStatus,
} from "./workspace-runtime.js";
import {
  assertExecId,
  execIdFromInvocationId,
  parseWorkspaceKey,
  workspaceExecStdoutStreamPath,
} from "./keys.js";

// ---------------------------------------------------------------------------
// Naming (A3 / docs/addressing.md §6)
// ---------------------------------------------------------------------------

export const WORKSPACE_SERVICE_NAME = "workspace";

// ---------------------------------------------------------------------------
// Config + defaults
// ---------------------------------------------------------------------------

export interface WorkspaceObjectConfig {
  /** How the object reaches the executor host (T4.1 seam; ./host-client.ts). */
  host: WorkspaceHostClient;
  /** Default adapter-enforced exec timeout. Default 10 min (SPIKE §d). */
  defaultExecTimeoutMs?: number;
  /** Hard cap on caller-requested exec timeouts. Default 60 min. */
  maxExecTimeoutMs?: number;
  /**
   * Grace added to the exec timeout for the AWAKEABLE backstop: the adapter
   * kill fires at `timeoutMs`; only a dead/unreachable host lets the
   * awakeable timer (`timeoutMs + grace`) fire. Default 30 s.
   */
  awakeableGraceMs?: number;
  /** Default/cap for tail bytes per channel in exec results (R4). Defaults 8 KiB / 128 KiB. */
  defaultMaxTailBytes?: number;
  maxTailBytesCap?: number;
  /** Default/cap for `fsRead` budgets (R4: journal entries ≤ ~1 MiB). Defaults 256 KiB / 1 MiB. */
  defaultFsReadBytes?: number;
  maxFsReadBytesCap?: number;
  /** Per-handler Restate timeouts (A4 §3 — must exceed worst-case host-call latency). Defaults 10 min each. */
  inactivityTimeoutMs?: number;
  abortTimeoutMs?: number;
}

export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_EXEC_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_AWAKEABLE_GRACE_MS = 30_000;
export const DEFAULT_MAX_TAIL_BYTES = 8 * 1024;
export const DEFAULT_MAX_TAIL_BYTES_CAP = 128 * 1024;
export const DEFAULT_FS_READ_BYTES = 256 * 1024;
export const DEFAULT_FS_READ_BYTES_CAP = 1024 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 10 * 60_000;

function resolved(config: WorkspaceObjectConfig) {
  return {
    defaultExecTimeoutMs: config.defaultExecTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    maxExecTimeoutMs: config.maxExecTimeoutMs ?? DEFAULT_MAX_EXEC_TIMEOUT_MS,
    awakeableGraceMs: config.awakeableGraceMs ?? DEFAULT_AWAKEABLE_GRACE_MS,
    defaultMaxTailBytes: config.defaultMaxTailBytes ?? DEFAULT_MAX_TAIL_BYTES,
    maxTailBytesCap: config.maxTailBytesCap ?? DEFAULT_MAX_TAIL_BYTES_CAP,
    defaultFsReadBytes: config.defaultFsReadBytes ?? DEFAULT_FS_READ_BYTES,
    maxFsReadBytesCap: config.maxFsReadBytesCap ?? DEFAULT_FS_READ_BYTES_CAP,
  };
}

// ---------------------------------------------------------------------------
// Handler inputs / results
// ---------------------------------------------------------------------------

export interface WorkspaceEnsureInput {
  config: WorkspaceEnsureConfig;
}

export interface WorkspaceEnsureResult {
  workspaceKey: string;
  adapter: string;
  workingDirectory: string;
  readContainment: "workspace" | "environment";
  /** True when the workspace was already ensured (idempotent reattach — original config kept, D4). */
  reattached: boolean;
}

export interface WorkspaceExecInput {
  /** Shell command line. */
  command: string;
  /** Caller-supplied dedup/stream id (addressing id charset). Default: derived from the invocation id. */
  execId?: string;
  /** Working directory relative to the workspace root (contained). */
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  /** Adapter-enforced hard timeout; clamped to the object's cap. */
  timeoutMs?: number;
  /** Tail budget per channel; clamped to the object's cap (R4). */
  maxTailBytes?: number;
}

export type ExecOutcome = "completed" | "timeout" | "killed";

/** The awaited exec result — D4's `{ exitCode, tailBytes, streamRef }`, journal-bounded (R4). */
export interface WorkspaceExecResult {
  execId: string;
  outcome: ExecOutcome;
  exitCode: number | null;
  signal: string | null;
  /** Last N bytes per channel — the only output in the journal/timeline. */
  tailBytes: { stdout: string; stderr: string; truncated: boolean };
  /** Durable-stream path carrying the full stdout/stderr, out-of-band. */
  streamRef: string;
  durationMs: number;
  /** Present on `outcome: "timeout"`: which timer fired. `host-unresponsive` = the awakeable backstop. */
  timeoutKind?: "exec" | "host-unresponsive";
}

export interface WorkspaceKillInput {
  /** Only kill if this specific exec is the one in flight (guards racing kills). */
  execId?: string;
  /**
   * Also `ctx.cancel` the in-flight exclusive invocation. Normally
   * unnecessary — the host kill makes the exec's awakeable resolve with
   * `killed: true` and the exec handler returns normally. Use when the HOST
   * is suspected dead (nothing will resolve the awakeable before its
   * timeout) and the workspace queue must unblock immediately.
   */
  force?: boolean;
}

export type WorkspaceKillResult =
  | {
      killed: false;
      reason: "no-exec-in-flight" | "exec-id-mismatch" | "not-ensured";
      currentExecId?: string;
    }
  | { killed: true; execId: string; hostKilled: boolean; invocationCancelled: boolean };

export interface WorkspaceStatusResult {
  workspaceKey: string;
  status: WorkspaceStatus | "uninitialized";
  adapter?: string;
  currentExec?: CurrentExecInfo;
}

export interface WorkspaceDisposeInput {
  /** Destroy persisted environment state; default preserves it for a later re-`ensure`. */
  wipe?: boolean;
}

export interface WorkspaceFsPathInput {
  path: string;
}
export interface WorkspaceFsReadInput extends WorkspaceFsPathInput {
  maxBytes?: number;
}
export interface WorkspaceFsWriteInput extends WorkspaceFsPathInput {
  content: string;
  encoding?: "utf8" | "base64";
}
export interface WorkspaceFsMkdirInput extends WorkspaceFsPathInput {
  recursive?: boolean;
}
export interface WorkspaceFsRmInput extends WorkspaceFsPathInput {
  recursive?: boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();

async function requireRef(ctx: {
  key: string;
  get<T>(name: string): Promise<T | null>;
}): Promise<HostWorkspaceRef> {
  const config = await ctx.get<WorkspaceEnsureConfig>(WORKSPACE_KV.config);
  if (!config) {
    throw new restate.TerminalError(
      `workspace ${ctx.key} is not ensured (call ensure(config) first, or it was disposed)`,
      { errorCode: 409 },
    );
  }
  return { workspaceKey: ctx.key, config };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

// ---------------------------------------------------------------------------
// Handlers (logic — unit-testable against fakes; see workspace.test.ts)
// ---------------------------------------------------------------------------

/**
 * Create/reattach the environment. Idempotent; the environment identity is
 * fixed at first ensure (D4 "no mid-session switching"): a re-ensure naming
 * a DIFFERENT adapter is a terminal error, a re-ensure with the same adapter
 * keeps the ORIGINAL stored config and just re-warms the host.
 */
export async function handleEnsure(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceEnsureInput,
): Promise<WorkspaceEnsureResult> {
  parseWorkspaceKey(ctx.key); // validate the object key shape early (A3 empty/malformed-key footgun)
  if (!input?.config?.adapter) {
    throw new restate.TerminalError(`ensure requires config.adapter`);
  }
  const existing = await ctx.get<WorkspaceEnsureConfig>(WORKSPACE_KV.config);
  if (existing && existing.adapter !== input.config.adapter) {
    throw new restate.TerminalError(
      `workspace ${ctx.key} is bound to adapter ${JSON.stringify(existing.adapter)}; ` +
        `switching to ${JSON.stringify(input.config.adapter)} is not allowed (D4). dispose() first.`,
    );
  }
  const effective = existing ?? input.config;
  const result = await config.host.ensure(ctx, { workspaceKey: ctx.key, config: effective });
  ctx.set(WORKSPACE_KV.config, effective);
  ctx.set<WorkspaceStatus>(WORKSPACE_KV.status, "ready");
  return {
    workspaceKey: ctx.key,
    adapter: result.adapter,
    workingDirectory: result.workingDirectory,
    readContainment: result.readContainment,
    reattached: existing !== null,
  };
}

/** Run a command to completion via the long-exec awakeable protocol (module header). */
export async function handleExec(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceExecInput,
): Promise<WorkspaceExecResult> {
  const r = resolved(config);
  const ref = await requireRef(ctx);
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new restate.TerminalError(`exec requires a non-empty command`);
  }
  if (input.execId !== undefined) assertExecId(input.execId);
  const execId = input.execId ?? execIdFromInvocationId(ctx.invocationId);
  const timeoutMs = clamp(input.timeoutMs ?? r.defaultExecTimeoutMs, 1, r.maxExecTimeoutMs);
  const maxTailBytes = clamp(input.maxTailBytes ?? r.defaultMaxTailBytes, 0, r.maxTailBytesCap);
  const streamPath = workspaceExecStdoutStreamPath(ctx.key, execId);

  // Escape-hatch targets: visible LIVE to the shared kill/status handlers
  // while this exclusive handler is blocked on the awakeable (SPIKE §a-2).
  ctx.set(WORKSPACE_KV.currentInvocationId, ctx.invocationId);
  const startedAt = await ctx.run("now-exec", () => Date.now());
  ctx.set<CurrentExecInfo>(WORKSPACE_KV.currentExec, {
    execId,
    command: input.command,
    streamPath,
    startedTs: iso(startedAt),
  });

  try {
    // Awakeable id is journaled — a retried attempt waits on the SAME id
    // (SPIKE §d-4), and the journaled dispatch pairs it with the same execId
    // (host-side dedup), so at-least-once dispatch stays single-execution.
    const awakeable = ctx.awakeable<ExecCompletion>();
    await config.host.startExec(ctx, {
      ref,
      execId,
      command: input.command,
      ...(input.cwd !== undefined && { cwd: input.cwd }),
      ...(input.env !== undefined && { env: input.env }),
      ...(input.stdin !== undefined && { stdin: input.stdin }),
      timeoutMs,
      maxTailBytes,
      awakeableId: awakeable.id,
      streamPath,
    });

    try {
      const completion = await ctx.awaitAwakeable(awakeable, timeoutMs + r.awakeableGraceMs);
      const outcome: ExecOutcome = completion.timedOut
        ? "timeout"
        : completion.killed
          ? "killed"
          : "completed";
      return {
        execId,
        outcome,
        exitCode: completion.exitCode,
        signal: completion.signal,
        tailBytes: {
          stdout: completion.tail.stdout,
          stderr: completion.tail.stderr,
          truncated: completion.tail.truncated,
        },
        streamRef: streamPath,
        durationMs: completion.durationMs,
        ...(outcome === "timeout" && { timeoutKind: "exec" as const }),
      };
    } catch (err) {
      if (err instanceof WorkspaceExecTimeoutError) {
        // Backstop fired: host never resolved (dead/unreachable, or its kill
        // never landed). Try a durable kill — idempotent, unknown-exec-safe —
        // and surface a structured timeout instead of wedging the key.
        await config.host.killExec(ctx, { ref, execId });
        return {
          execId,
          outcome: "timeout",
          exitCode: null,
          signal: null,
          tailBytes: { stdout: "", stderr: "", truncated: false },
          streamRef: streamPath,
          durationMs: timeoutMs + r.awakeableGraceMs,
          timeoutKind: "host-unresponsive",
        };
      }
      if (err instanceof WorkspaceInterruptedError) {
        // Cancelled (kill --force / operator). explicitCancellation (A4):
        // durable cleanup still works — kill the process, return killed.
        await config.host.killExec(ctx, { ref, execId });
        const endedAt = await ctx.run("now-exec-killed", () => Date.now());
        return {
          execId,
          outcome: "killed",
          exitCode: null,
          signal: null,
          tailBytes: { stdout: "", stderr: "", truncated: false },
          streamRef: streamPath,
          durationMs: Math.max(0, endedAt - startedAt),
        };
      }
      throw err;
    }
  } finally {
    ctx.clear(WORKSPACE_KV.currentExec);
    ctx.clear(WORKSPACE_KV.currentInvocationId);
  }
}

/**
 * SHARED escape hatch (anticipate-a) — the workspace analogue of the agent
 * object's shared `signal`: runs concurrently with a blocked exclusive
 * `exec`, never queues behind it. See `WorkspaceKillInput.force` for the
 * two-stage semantics.
 */
export async function handleKill(
  ctx: WorkspaceSharedRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceKillInput = {},
): Promise<WorkspaceKillResult> {
  const cfg = await ctx.get<WorkspaceEnsureConfig>(WORKSPACE_KV.config);
  if (!cfg) return { killed: false, reason: "not-ensured" };
  const current = await ctx.get<CurrentExecInfo>(WORKSPACE_KV.currentExec);
  if (!current) return { killed: false, reason: "no-exec-in-flight" };
  if (input.execId !== undefined && input.execId !== current.execId) {
    return { killed: false, reason: "exec-id-mismatch", currentExecId: current.execId };
  }

  const hostResult = await config.host.killExec(ctx, {
    ref: { workspaceKey: ctx.key, config: cfg },
    execId: current.execId,
  });

  let invocationCancelled = false;
  if (input.force) {
    const inFlight = await ctx.get<string>(WORKSPACE_KV.currentInvocationId);
    if (inFlight) {
      // Cancel-of-completed is a harmless 409 (SPIKE §a-3) — no TOCTOU hazard.
      ctx.cancelInvocation(inFlight);
      invocationCancelled = true;
    }
  }
  return {
    killed: true,
    execId: current.execId,
    hostKilled: hostResult.killed,
    invocationCancelled,
  };
}

/** SHARED cheap status read (mirrors the agent object's live-K/V visibility, SPIKE §a-2). */
export async function handleStatus(ctx: WorkspaceSharedRuntimeCtx): Promise<WorkspaceStatusResult> {
  const status = await ctx.get<WorkspaceStatus>(WORKSPACE_KV.status);
  const config = await ctx.get<WorkspaceEnsureConfig>(WORKSPACE_KV.config);
  const currentExec = await ctx.get<CurrentExecInfo>(WORKSPACE_KV.currentExec);
  return {
    workspaceKey: ctx.key,
    status: status ?? "uninitialized",
    ...(config && { adapter: config.adapter }),
    ...(currentExec && { currentExec }),
  };
}

/** Tear the environment down (host-side), clear coordination K/V. Re-`ensure` starts a fresh binding. */
export async function handleDispose(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceDisposeInput = {},
): Promise<{ disposed: boolean; wiped: boolean }> {
  const existing = await ctx.get<WorkspaceEnsureConfig>(WORKSPACE_KV.config);
  if (!existing) return { disposed: false, wiped: false }; // idempotent no-op
  await config.host.dispose(ctx, {
    ref: { workspaceKey: ctx.key, config: existing },
    ...(input.wipe !== undefined && { wipe: input.wipe }),
  });
  ctx.clear(WORKSPACE_KV.config);
  ctx.clear(WORKSPACE_KV.currentExec);
  ctx.set<WorkspaceStatus>(WORKSPACE_KV.status, "disposed");
  return { disposed: true, wiped: input.wipe ?? false };
}

// --- FS handlers (PLAN's `fs.{read,write,mkdir,rm,stat,ls}` surface) --------

async function runFs<T>(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  req: HostFsOp,
  pick: (res: Extract<HostFsResult, { ok: true }>) => T,
): Promise<T> {
  const ref = await requireRef(ctx);
  const result = await config.host.fs(ctx, { ref, ...req });
  if (!result.ok) {
    // Containment/runtime failures are terminal — retrying the invocation
    // cannot make `../../etc/passwd` legal or a missing file appear.
    throw new restate.TerminalError(
      `[${result.error.kind}] fs ${req.op} ${JSON.stringify(req.path)}: ${result.error.message}`,
    );
  }
  return pick(result);
}

export async function handleFsRead(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceFsReadInput,
): Promise<ReadResult> {
  const r = resolved(config);
  const maxBytes = clamp(input.maxBytes ?? r.defaultFsReadBytes, 1, r.maxFsReadBytesCap);
  return runFs(ctx, config, { op: "read", path: input.path, maxBytes }, (res) =>
    res.op === "read" ? res.result : unexpected(res.op),
  );
}

export async function handleFsWrite(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceFsWriteInput,
): Promise<{ written: true }> {
  return runFs(
    ctx,
    config,
    {
      op: "write",
      path: input.path,
      content: input.content,
      ...(input.encoding && { encoding: input.encoding }),
    },
    () => ({ written: true }),
  );
}

export async function handleFsMkdir(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceFsMkdirInput,
): Promise<{ created: true }> {
  return runFs(
    ctx,
    config,
    {
      op: "mkdir",
      path: input.path,
      ...(input.recursive !== undefined && { recursive: input.recursive }),
    },
    () => ({
      created: true,
    }),
  );
}

export async function handleFsRm(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceFsRmInput,
): Promise<{ removed: true }> {
  return runFs(
    ctx,
    config,
    {
      op: "rm",
      path: input.path,
      ...(input.recursive !== undefined && { recursive: input.recursive }),
    },
    () => ({
      removed: true,
    }),
  );
}

export async function handleFsStat(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceFsPathInput,
): Promise<FileStat> {
  return runFs(ctx, config, { op: "stat", path: input.path }, (res) =>
    res.op === "stat" ? res.result : unexpected(res.op),
  );
}

export async function handleFsLs(
  ctx: WorkspaceRuntimeCtx,
  config: WorkspaceObjectConfig,
  input: WorkspaceFsPathInput,
): Promise<DirEntry[]> {
  return runFs(ctx, config, { op: "ls", path: input.path }, (res) =>
    res.op === "ls" ? res.result : unexpected(res.op),
  );
}

function unexpected(op: string): never {
  throw new restate.TerminalError(
    `executor host returned mismatched fs result op ${JSON.stringify(op)}`,
  );
}

// ---------------------------------------------------------------------------
// Restate wiring — thin adapters (no independent logic), agent.ts pattern.
// ---------------------------------------------------------------------------

function adaptExclusive(ctx: restate.ObjectContext): WorkspaceRuntimeCtx {
  // A4 seam (SPIKE §a, verbatim from coordination/agent.ts): the cancellation
  // API is @experimental in SDK 1.16 — version pinned, conformance-tested
  // live in T6.3/T9.1.
  const ctxInternal = ctx as unknown as restate.internal.ContextInternal;
  const interruptAbort = new AbortController();
  return {
    key: ctx.key,
    invocationId: ctx.request().id,
    get: <T>(name: string) => ctx.get<T>(name),
    set: <T>(name: string, value: T) => {
      ctx.set<T>(name, value);
    },
    clear: (name: string) => {
      ctx.clear(name);
    },
    run: <T>(name: string, action: () => T | Promise<T>) => ctx.run<T>(name, async () => action()),
    genericCall: <REQ, RES>(call: {
      service: string;
      method: string;
      key?: string;
      parameter: REQ;
    }) =>
      ctx.genericCall<REQ, RES>({
        ...call,
        inputSerde: restate.serde.json as restate.Serde<REQ>,
        outputSerde: restate.serde.json as restate.Serde<RES>,
      }) as Promise<RES>,
    awakeable: <T>() => {
      const a = ctx.awakeable<T>();
      return { id: a.id, promise: a.promise };
    },
    awaitAwakeable: async <T>(
      awakeable: { id: string; promise: Promise<T> },
      timeoutMs: number,
    ) => {
      const interrupted = ctxInternal.cancellation().map(() => {
        interruptAbort.abort(); // idempotent — .map may run more than once (SPIKE §a-5)
        throw new WorkspaceInterruptedError();
      });
      try {
        return await restate.RestatePromise.race([
          (awakeable.promise as restate.RestatePromise<T>).orTimeout(timeoutMs),
          interrupted as restate.RestatePromise<never>,
        ]);
      } catch (err) {
        if (err instanceof restate.TimeoutError) throw new WorkspaceExecTimeoutError();
        throw err;
      }
    },
  };
}

function adaptShared(ctx: restate.ObjectSharedContext): WorkspaceSharedRuntimeCtx {
  return {
    key: ctx.key,
    get: <T>(name: string) => ctx.get<T>(name),
    run: <T>(name: string, action: () => T | Promise<T>) => ctx.run<T>(name, async () => action()),
    genericCall: <REQ, RES>(call: {
      service: string;
      method: string;
      key?: string;
      parameter: REQ;
    }) =>
      ctx.genericCall<REQ, RES>({
        ...call,
        inputSerde: restate.serde.json as restate.Serde<REQ>,
        outputSerde: restate.serde.json as restate.Serde<RES>,
      }) as Promise<RES>,
    cancelInvocation: (invocationId: string) => {
      ctx.cancel(invocationId as restate.InvocationId);
    },
  };
}

/**
 * Build the `workspace` virtual object. `explicitCancellation: true` is
 * MANDATORY (A4): without it, the post-cancel durable host-kill cleanup in
 * `handleExec` would be impossible (all awaits rethrow after cancel).
 */
export function createWorkspaceObject(config: WorkspaceObjectConfig) {
  const handlerOpts = {
    inactivityTimeout: config.inactivityTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
    abortTimeout: config.abortTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
  };
  const exclusive = <I, O>(
    fn: (ctx: WorkspaceRuntimeCtx, config: WorkspaceObjectConfig, input: I) => Promise<O>,
  ) =>
    restate.handlers.object.exclusive(
      handlerOpts,
      async (ctx: restate.ObjectContext, input: I): Promise<O> =>
        fn(adaptExclusive(ctx), config, input),
    );
  return restate.object({
    name: WORKSPACE_SERVICE_NAME,
    handlers: {
      ensure: exclusive(handleEnsure),
      exec: exclusive(handleExec),
      fsRead: exclusive(handleFsRead),
      fsWrite: exclusive(handleFsWrite),
      fsMkdir: exclusive(handleFsMkdir),
      fsRm: exclusive(handleFsRm),
      fsStat: exclusive(handleFsStat),
      fsLs: exclusive(handleFsLs),
      dispose: exclusive(handleDispose),
      kill: restate.handlers.object.shared(
        async (
          ctx: restate.ObjectSharedContext,
          input: WorkspaceKillInput,
        ): Promise<WorkspaceKillResult> => handleKill(adaptShared(ctx), config, input),
      ),
      status: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext): Promise<WorkspaceStatusResult> =>
          handleStatus(adaptShared(ctx)),
      ),
    },
    options: { explicitCancellation: true },
  });
}

export type WorkspaceObject = ReturnType<typeof createWorkspaceObject>;
