/**
 * `docker` adapter (0001:T4.2) — one container per workspace (`workspace/<key>`),
 * volume-backed working dir, idle teardown with a grace period, reattach.
 * Container isolation is the boundary, so this is the first adapter 0001:D4 marks
 * production-shaped ("Docker first").
 *
 * ## Container-per-workspace + volume backing
 *
 * Every `workspace/<key>` gets ONE deterministically-named container and ONE
 * named volume mounted at the working dir (`/work` by default). Identity comes
 * from the key alone (name = slug + hash of the key), so a restarted executor
 * host transparently reattaches — no in-process memory (the ExecutorAdapter
 * contract). Files under the working dir live on the VOLUME, so they persist
 * across every exec in the workspace's life AND across container stop/remove:
 * even an ephemeral idle teardown that removes the container leaves the volume,
 * and the next `ensure`/exec recreates the container against it.
 *
 * ## Idle-teardown lifecycle state machine (see DockerWorkspaceEnv)
 *
 * A per-env activity counter tracks in-flight ops (execs + fs). When it hits
 * zero an idle timer is armed for `idleGraceMs`; if a new op arrives during the
 * grace the timer is cancelled and the still-warm container is REATTACHED (no
 * teardown). If the grace elapses idle, the container is torn down —
 * STOPPED when `persistent` (writable layer preserved) or REMOVED otherwise
 * (volume still preserved either way). The next op reattaches: `inspect` →
 * start a stopped container or recreate a removed one. `dispose({wipe})`
 * removes the container and, with `wipe`, the volume too. The machine runs
 * under a per-env mutex so a reattach can never interleave with an in-flight
 * teardown (ported from electric's per-key lock). This is the tactical pattern
 * lifted from `../electric/.../sandbox/docker.ts` — refcount + debounced
 * teardown + reattach — mapped onto the 0001:T4.1 host↔adapter seam (the host caches
 * one DockerWorkspaceEnv per key; the container comes and goes beneath it).
 *
 * ## Kill / escape hatch → the 0001:T4.1 shared-kill seam
 *
 * `startExec().kill()` maps to an in-container marker-scan `kill -KILL` (only
 * this exec's tree; see docker-cli.ts). The workspace object's shared `kill`
 * handler (0001:T4.1, runs concurrently with the blocked exclusive `exec`) calls the
 * host, which calls the exec handle's `kill()` — identical wiring to `local`.
 * `dispose` kills every running exec first (host `docker stop`/`rm`).
 *
 * ## Containment / read semantics (readContainment: "workspace")
 *
 * Isolated adapter ⇒ STRING-LEVEL containment (`containWorkspacePath`): the
 * container/volume root is the real boundary. Writes are contained to the
 * working dir on every op; reads are likewise contained to the working dir (a
 * path resolving outside `/work` rejects with `policy`). An in-container symlink
 * that escapes `/work` is NOT separately rejected — the container is the
 * isolation boundary (see path-containment.ts module docs). FS ops run through
 * the container's own mount namespace via `docker exec` (base64 for binary-safe
 * read/write; paths passed as positional args, never interpolated into the
 * shell, so no injection).
 */

import { createHash } from "node:crypto";
import type {
  DirEntry,
  EnsureParams,
  ExecCompletion,
  ExecHandle,
  ExecStartOpts,
  ExecutorAdapter,
  FileStat,
  ReadResult,
  WorkspaceEnsureConfig,
  WorkspaceEnv,
} from "./adapter.js";
import {
  createDockerCli,
  DockerNameConflictError,
  type ContainerCreateSpec,
  type DockerCli,
  type DockerCliOptions,
  type DockerRunResult,
} from "./docker-cli.js";
import { WorkspaceError } from "./errors.js";
import { parseWorkspaceKey } from "./keys.js";
import { containWorkspacePath } from "./path-containment.js";

export const DEFAULT_DOCKER_IMAGE = "alpine:3.20";
export const DEFAULT_WORKING_DIRECTORY = "/work";
export const DEFAULT_IDLE_GRACE_MS = 5 * 60_000;
/** Read budget for the docker adapter's FS reads (private; local-adapter owns the exported name). */
const DEFAULT_FS_READ_BUDGET_BYTES = 256 * 1024;

const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CPUS = 2;
const DEFAULT_PIDS_LIMIT = 1024;

export interface DockerAdapterOptions {
  /** Injectable client (a fake in unit tests). Defaults to the real CLI client. */
  cli?: DockerCli;
  /** Options for the default CLI client (ignored when `cli` is supplied). */
  cliOptions?: DockerCliOptions;
  /** Default image; per-workspace `adapterOptions.image` overrides. */
  defaultImage?: string;
  /** Container path of the writable, volume-backed root. Default `/work`. */
  workingDirectory?: string;
  /** Idle window before an idle container is torn down; a new op cancels it. */
  idleGraceMs?: number;
  /** Idle teardown action: `true` ⇒ STOP (preserve writable layer); `false` ⇒ REMOVE. Default true. */
  persistentByDefault?: boolean;
  /** Network policy: `bridge` (egress) or `none` (hard isolation). Default `bridge`. */
  network?: "none" | "bridge";
  resources?: { memoryBytes?: number; cpus?: number; pidsLimit?: number };
  /** Ping the daemon on the first `ensure` so unavailability surfaces cleanly. Default true. */
  probeOnEnsure?: boolean;
}

interface ResolvedDockerConfig {
  image: string;
  network: "none" | "bridge";
  memoryBytes: number;
  cpus: number;
  pidsLimit: number;
  idleGraceMs: number;
  persistent: boolean;
}

export function createDockerAdapter(opts: DockerAdapterOptions = {}): ExecutorAdapter {
  const cli = opts.cli ?? createDockerCli(opts.cliOptions);
  const workingDirectory = opts.workingDirectory ?? DEFAULT_WORKING_DIRECTORY;
  const adapterDefaults = {
    image: opts.defaultImage ?? DEFAULT_DOCKER_IMAGE,
    network: opts.network ?? "bridge",
    memoryBytes: opts.resources?.memoryBytes ?? DEFAULT_MEMORY_BYTES,
    cpus: opts.resources?.cpus ?? DEFAULT_CPUS,
    pidsLimit: opts.resources?.pidsLimit ?? DEFAULT_PIDS_LIMIT,
    idleGraceMs: opts.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS,
    persistent: opts.persistentByDefault ?? true,
  } satisfies ResolvedDockerConfig;
  const probeOnEnsure = opts.probeOnEnsure ?? true;
  let probed = false;

  return {
    name: "docker",
    readContainment: "workspace",
    async ensure({ workspaceKey, config }: EnsureParams): Promise<WorkspaceEnv> {
      parseWorkspaceKey(workspaceKey); // validates charset — no traversal via key
      if (probeOnEnsure && !probed) {
        await cli.ping();
        probed = true;
      }
      const resolved = resolveConfig(adapterDefaults, config);
      const env = new DockerWorkspaceEnv(cli, workspaceKey, workingDirectory, config.env ?? {}, resolved);
      await env.ensure();
      return env;
    },
  };
}

/** Per-workspace resolved config: adapter defaults overlaid with `adapterOptions`. */
function resolveConfig(
  defaults: ResolvedDockerConfig,
  config: WorkspaceEnsureConfig,
): ResolvedDockerConfig {
  const raw = (config.adapterOptions ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    image: typeof raw.image === "string" ? raw.image : defaults.image,
    network: raw.network === "none" || raw.network === "bridge" ? raw.network : defaults.network,
    memoryBytes: num(raw.memoryBytes, defaults.memoryBytes),
    cpus: num(raw.cpus, defaults.cpus),
    pidsLimit: num(raw.pidsLimit, defaults.pidsLimit),
    idleGraceMs: num(raw.idleGraceMs, defaults.idleGraceMs),
    persistent: typeof raw.persistent === "boolean" ? raw.persistent : defaults.persistent,
  };
}

// ---------------------------------------------------------------------------
// The environment + lifecycle state machine
// ---------------------------------------------------------------------------

class DockerWorkspaceEnv implements WorkspaceEnv {
  readonly workspaceKey: string;
  readonly workingDirectory: string;
  readonly containerName: string;
  readonly volumeName: string;

  private readonly cli: DockerCli;
  private readonly baseEnv: Record<string, string>;
  private readonly cfg: ResolvedDockerConfig;

  /** In-flight ops (execs + fs) that keep the container warm. */
  private activeOps = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Serializes ensureUp against teardown so a reattach can't race a stop/remove. */
  private lock: Promise<unknown> = Promise.resolve();
  private readonly runningExecs = new Set<ExecHandle>();

  constructor(
    cli: DockerCli,
    workspaceKey: string,
    workingDirectory: string,
    baseEnv: Record<string, string>,
    cfg: ResolvedDockerConfig,
  ) {
    this.cli = cli;
    this.workspaceKey = workspaceKey;
    this.workingDirectory = workingDirectory;
    this.baseEnv = baseEnv;
    this.cfg = cfg;
    const { tenant, name } = parseWorkspaceKey(workspaceKey);
    const hash = createHash("sha256").update(workspaceKey).digest("hex").slice(0, 8);
    this.containerName = `teaspill-${slug(tenant)}-${slug(name)}-${hash}`;
    this.volumeName = `teaspill-vol-${hash}`;
  }

  /** Bring the container up (create-or-reattach) and arm the idle timer. */
  async ensure(): Promise<void> {
    await this.touch(async () => undefined);
  }

  startExec(opts: ExecStartOpts): ExecHandle {
    // The op lasts until the exec completes, so `beginOp` here and `endOp` when
    // the completion settles (arming idle only once the workspace is quiet).
    this.beginOp();

    const cwd =
      opts.cwd === undefined
        ? this.workingDirectory
        : containWorkspacePath(this.workingDirectory, opts.cwd);

    let innerHandle: ExecHandle | undefined;
    let killRequested = false;

    const completion: Promise<ExecCompletion> = (async () => {
      const startedAt = Date.now();
      try {
        await this.ensureUp();
        innerHandle = this.cli.startExec(this.containerName, {
          execId: opts.execId,
          command: opts.command,
          cwd,
          env: { ...this.baseEnv, ...opts.env },
          ...(opts.stdin !== undefined && { stdin: opts.stdin }),
          timeoutMs: opts.timeoutMs,
          maxTailBytes: opts.maxTailBytes,
          ...(opts.onChunk !== undefined && { onChunk: opts.onChunk }),
          ...(opts.signal !== undefined && { signal: opts.signal }),
        });
        this.runningExecs.add(innerHandle);
        if (killRequested) innerHandle.kill();
        const done = await innerHandle.wait();
        return done;
      } catch (err) {
        // ensureUp failed (daemon unavailable, create error): surface as an exec
        // failure completion rather than rejecting (ExecHandle never rejects).
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          killed: killRequested,
          tail: {
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            truncated: false,
          },
          durationMs: Date.now() - startedAt,
        } satisfies ExecCompletion;
      } finally {
        if (innerHandle) this.runningExecs.delete(innerHandle);
        this.endOp();
      }
    })();

    return {
      execId: opts.execId,
      wait: () => completion,
      kill: () => {
        killRequested = true;
        innerHandle?.kill();
      },
    };
  }

  async readFile(path: string, opts?: { maxBytes?: number }): Promise<ReadResult> {
    const target = containWorkspacePath(this.workingDirectory, path);
    const budget = opts?.maxBytes ?? DEFAULT_FS_READ_BUDGET_BYTES;
    return this.touch(async () => {
      const r = await this.cli.runExec(this.containerName, ["sh", "-c", 'base64 -- "$1"', "sh", target]);
      if (r.exitCode !== 0) throw fsError(r, "read", path);
      const buf = Buffer.from(r.stdout.toString(), "base64");
      const truncated = buf.length > budget;
      const slice = truncated ? buf.subarray(0, budget) : buf;
      return { content: slice.toString("utf8"), encoding: "utf8", size: buf.length, truncated };
    });
  }

  async writeFile(
    path: string,
    content: string,
    opts?: { encoding?: "utf8" | "base64" },
  ): Promise<void> {
    const target = containWorkspacePath(this.workingDirectory, path);
    const b64 = Buffer.from(content, opts?.encoding ?? "utf8").toString("base64");
    return this.touch(async () => {
      const r = await this.cli.runExec(
        this.containerName,
        ["sh", "-c", 'base64 -d > "$1"', "sh", target],
        { stdin: b64 },
      );
      if (r.exitCode !== 0) throw fsError(r, "write", path);
    });
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const target = containWorkspacePath(this.workingDirectory, path);
    return this.touch(async () => {
      const cmd = opts?.recursive ? ["mkdir", "-p", target] : ["mkdir", target];
      const r = await this.cli.runExec(this.containerName, cmd);
      if (r.exitCode !== 0) throw fsError(r, "mkdir", path);
    });
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const target = containWorkspacePath(this.workingDirectory, path);
    if (target === this.workingDirectory) {
      throw new WorkspaceError("policy", "refusing to rm the workspace root itself (use dispose)");
    }
    return this.touch(async () => {
      const cmd = opts?.recursive ? ["rm", "-r", target] : ["rm", target];
      const r = await this.cli.runExec(this.containerName, cmd);
      if (r.exitCode !== 0) throw fsError(r, "rm", path);
    });
  }

  async stat(path: string): Promise<FileStat> {
    const target = containWorkspacePath(this.workingDirectory, path);
    return this.touch(async () => {
      const r = await this.cli.runExec(this.containerName, ["sh", "-c", STAT_SCRIPT, "sh", target]);
      if (r.exitCode === EXIT_NOENT) throw noEntError("stat", path);
      if (r.exitCode !== 0) throw fsError(r, "stat", path);
      const [type, size, mtime] = r.stdout.toString().split("\n");
      return {
        type: asEntryType(type),
        size: Number(size) || 0,
        mtimeMs: (Number(mtime) || 0) * 1000,
      };
    });
  }

  async ls(path: string): Promise<DirEntry[]> {
    const target = containWorkspacePath(this.workingDirectory, path);
    return this.touch(async () => {
      const r = await this.cli.runExec(this.containerName, ["sh", "-c", LS_SCRIPT, "sh", target]);
      if (r.exitCode === EXIT_NOENT) throw noEntError("ls", path);
      if (r.exitCode !== 0) throw fsError(r, "ls", path);
      return r.stdout
        .toString()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const tab = line.indexOf("\t");
          return { name: line.slice(tab + 1), type: asEntryType(line.slice(0, tab)) };
        });
    });
  }

  async dispose(opts?: { wipe?: boolean }): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const handle of this.runningExecs) handle.kill();
    await this.runExclusive(async () => {
      if (opts?.wipe) {
        await this.cli.removeContainer(this.containerName);
        await this.cli.removeVolume(this.volumeName);
      } else {
        // Preserve: stop the container (writable layer + volume survive) so a
        // later ensure reattaches. The host also drops its cached env, so the
        // next ensure rebuilds this object and reattaches by key.
        await this.cli.stopContainer(this.containerName);
      }
    });
  }

  // --- lifecycle internals ---------------------------------------------------

  /** Run an op that keeps the container warm: ensure-up, run, then arm idle. */
  private async touch<T>(fn: () => Promise<T>): Promise<T> {
    this.beginOp();
    try {
      await this.ensureUp();
      return await fn();
    } finally {
      this.endOp();
    }
  }

  private beginOp(): void {
    this.activeOps += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private endOp(): void {
    this.activeOps = Math.max(0, this.activeOps - 1);
    if (this.activeOps === 0 && !this.disposed) this.scheduleIdle();
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.runExclusive(async () => {
        if (this.activeOps > 0 || this.disposed) return; // re-acquired during the grace
        try {
          if (this.cfg.persistent) await this.cli.stopContainer(this.containerName);
          else await this.cli.removeContainer(this.containerName);
        } catch {
          /* already gone */
        }
      });
    }, this.cfg.idleGraceMs);
    this.idleTimer.unref?.();
  }

  /** Create-or-reattach the container (identity from key alone), serialized. */
  private ensureUp(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.disposed) {
        throw new WorkspaceError("unavailable", `workspace ${this.workspaceKey} is disposed`);
      }
      const state = await this.cli.inspectContainer(this.containerName);
      if (state === null) {
        // Absent → ensure the volume, then create+start. A lost create race
        // (another lease created it first) degrades to reattach.
        await this.cli.ensureVolume(this.volumeName);
        try {
          await this.cli.createContainer(this.spec());
        } catch (err) {
          if (err instanceof DockerNameConflictError) {
            await this.cli.startContainer(this.containerName).catch(() => undefined);
          } else {
            throw err;
          }
        }
      } else if (!state.running) {
        // Stopped (idle-preserved) → restart; volume + writable layer survive.
        await this.cli.startContainer(this.containerName);
      }
    });
  }

  private spec(): ContainerCreateSpec {
    return {
      name: this.containerName,
      image: this.cfg.image,
      volumeName: this.volumeName,
      workingDir: this.workingDirectory,
      env: { HOME: this.workingDirectory, ...this.baseEnv },
      labels: { "teaspill.managed": "1", "teaspill.workspace": this.workspaceKey },
      hostConfig: {
        networkMode: this.cfg.network,
        memoryBytes: this.cfg.memoryBytes,
        nanoCpus: Math.floor(this.cfg.cpus * 1_000_000_000),
        pidsLimit: this.cfg.pidsLimit,
      },
    };
  }

  /** Serialize a critical section on the per-env lock (mutex chain). */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    // Keep the chain alive but swallow the value/rejection for the NEXT waiter.
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// ---------------------------------------------------------------------------
// FS-over-exec shell probes + helpers
// ---------------------------------------------------------------------------

const EXIT_NOENT = 44;

/** Portable (busybox + GNU) stat probe. Emits `type\nsize\nmtimeSecs`; exit 44 if absent. */
const STAT_SCRIPT = [
  'p="$1"',
  'if [ -L "$p" ]; then t=symlink;',
  'elif [ -d "$p" ]; then t=directory;',
  'elif [ -f "$p" ]; then t=file;',
  'elif [ -e "$p" ]; then t=other;',
  "else exit 44; fi",
  's=$(wc -c < "$p" 2>/dev/null || echo 0)',
  'm=$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || echo 0)',
  'printf "%s\\n%s\\n%s\\n" "$t" "$s" "$m"',
].join("\n");

/** Portable directory lister. Emits `type\tname` per entry (incl. dotfiles); exit 44 if not a dir. */
const LS_SCRIPT = [
  'cd "$1" 2>/dev/null || exit 44',
  "for e in * .[!.]* ..?*; do",
  '  [ -e "$e" ] || [ -L "$e" ] || continue',
  '  if [ -L "$e" ]; then t=symlink;',
  '  elif [ -d "$e" ]; then t=directory;',
  '  elif [ -f "$e" ]; then t=file;',
  "  else t=other; fi",
  '  printf "%s\\t%s\\n" "$t" "$e"',
  "done",
].join("\n");

function asEntryType(t: string | undefined): DirEntry["type"] {
  return t === "directory" || t === "symlink" || t === "file" ? t : "other";
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, "-").slice(0, 40) || "ws";
}

function noEntError(op: string, path: string): WorkspaceError {
  return new WorkspaceError("runtime", `docker adapter ${op}(${JSON.stringify(path)}): no such file`);
}

function fsError(r: DockerRunResult, op: string, path: string): WorkspaceError {
  const stderr = r.stderr.toString().trim();
  return new WorkspaceError(
    "runtime",
    `docker adapter ${op}(${JSON.stringify(path)}) failed (exit ${r.exitCode ?? "?"})${
      stderr.length > 0 ? `: ${stderr}` : ""
    }`,
  );
}
