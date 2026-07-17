/**
 * `local` adapter (T4.1) — **DEV-ONLY**. Runs commands directly on the host
 * with NO isolation beyond filesystem path containment:
 *
 *   - exec is `sh -c` on the host — full host network, host env leakage via
 *     PATH/HOME, no resource limits. NEVER point production traffic at it.
 *   - FS ops ARE contained (realpath symlink-walking, ./path-containment.ts)
 *     — but a command run via exec can of course touch anything the host
 *     user can. Containment here protects against confused-deputy path bugs,
 *     not against hostile code.
 *
 * It exists so T4.1 can prove the object↔host↔adapter flow end to end with a
 * REAL environment (real process spawn/kill, real symlink semantics — things
 * a fake cannot exercise honestly). T4.2 promotes this into the loudly-warned
 * `local-unrestricted` profile and adds the `docker` adapter behind the same
 * interface.
 *
 * Process/exec mechanics ported from electric's
 * `../electric/packages/agents-runtime/src/sandbox/unrestricted.ts`:
 * detached process group + negative-PID kill tree (a plain `child.kill`
 * signals only `sh`, orphaning grandchildren that hold the stdio pipes),
 * SIGTERM → SIGKILL escalation, bounded output buffers.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  DirEntry,
  EnsureParams,
  ExecCompletion,
  ExecHandle,
  ExecStartOpts,
  ExecutorAdapter,
  FileStat,
  ReadResult,
  WorkspaceEnv,
} from "./adapter.js";
import { WorkspaceError } from "./errors.js";
import { parseWorkspaceKey } from "./keys.js";
import { resolveContainedPath } from "./path-containment.js";
import { TailBuffer } from "./tail-buffer.js";

export interface LocalAdapterOptions {
  /** Directory under which per-workspace roots are created (`<baseDir>/<tenant>/<name>`). */
  baseDir: string;
  /** Suppress the dev-only warning log (tests). */
  quiet?: boolean;
}

export const DEFAULT_FS_READ_BUDGET_BYTES = 256 * 1024;

/**
 * Create the dev-only local adapter. Environment identity derives from the
 * workspace key alone (`<baseDir>/<tenant>/<name>`), so a restarted host
 * reattaches to the same directory transparently.
 */
export function createLocalAdapter(opts: LocalAdapterOptions): ExecutorAdapter {
  if (!opts.quiet) {
    console.warn(
      "[teaspill/executor] `local` adapter active — DEV ONLY: commands run " +
        "directly on the host with no isolation. Use the docker adapter (T4.2) " +
        "for anything beyond local development.",
    );
  }
  return {
    name: "local",
    readContainment: "workspace",
    async ensure({ workspaceKey, config }: EnsureParams): Promise<WorkspaceEnv> {
      const { tenant, name } = parseWorkspaceKey(workspaceKey); // validates charset — no traversal via key
      const root = resolve(opts.baseDir, tenant, name);
      await mkdir(root, { recursive: true });
      return new LocalWorkspaceEnv(workspaceKey, root, config.env ?? {});
    },
  };
}

class LocalWorkspaceEnv implements WorkspaceEnv {
  constructor(
    readonly workspaceKey: string,
    readonly workingDirectory: string,
    private readonly baseEnv: Record<string, string>,
  ) {}

  private readonly running = new Set<ExecHandle>();

  startExec(opts: ExecStartOpts): ExecHandle {
    const handle = startLocalExec(this.workingDirectory, this.baseEnv, opts);
    this.running.add(handle);
    void handle.wait().finally(() => this.running.delete(handle));
    return handle;
  }

  async readFile(path: string, opts?: { maxBytes?: number }): Promise<ReadResult> {
    const target = await this.resolveRead(path);
    const budget = opts?.maxBytes ?? DEFAULT_FS_READ_BUDGET_BYTES;
    try {
      const buf = await readFile(target);
      const truncated = buf.length > budget;
      const slice = truncated ? buf.subarray(0, budget) : buf;
      return { content: slice.toString("utf8"), encoding: "utf8", size: buf.length, truncated };
    } catch (err) {
      throw wrapFsError(err, "read", path);
    }
  }

  async writeFile(
    path: string,
    content: string,
    opts?: { encoding?: "utf8" | "base64" },
  ): Promise<void> {
    const target = await resolveContainedPath(this.workingDirectory, path);
    try {
      await writeFile(target, Buffer.from(content, opts?.encoding ?? "utf8"));
    } catch (err) {
      throw wrapFsError(err, "write", path);
    }
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const target = await resolveContainedPath(this.workingDirectory, path);
    try {
      await mkdir(target, { recursive: opts?.recursive ?? false });
    } catch (err) {
      throw wrapFsError(err, "mkdir", path);
    }
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const target = await resolveContainedPath(this.workingDirectory, path);
    if (target === (await resolveContainedPath(this.workingDirectory, "."))) {
      throw new WorkspaceError("policy", "refusing to rm the workspace root itself (use dispose)");
    }
    try {
      await rm(target, { recursive: opts?.recursive ?? false, force: false });
    } catch (err) {
      throw wrapFsError(err, "rm", path);
    }
  }

  async stat(path: string): Promise<FileStat> {
    const target = await this.resolveRead(path);
    try {
      const s = await stat(target);
      return { type: entryType(s), size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      throw wrapFsError(err, "stat", path);
    }
  }

  async ls(path: string): Promise<DirEntry[]> {
    const target = await this.resolveRead(path);
    try {
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, type: entryType(e) }));
    } catch (err) {
      throw wrapFsError(err, "ls", path);
    }
  }

  async dispose(opts?: { wipe?: boolean }): Promise<void> {
    for (const handle of this.running) handle.kill();
    if (opts?.wipe) {
      await rm(this.workingDirectory, { recursive: true, force: true });
    }
  }

  /** `readContainment: "workspace"` — reads route through the same realpath containment as writes. */
  private resolveRead(path: string): Promise<string> {
    return resolveContainedPath(this.workingDirectory, path);
  }
}

// ---------------------------------------------------------------------------
// Exec (electric unrestricted.ts port: process group, kill tree, tail buffers)
// ---------------------------------------------------------------------------

const SIGKILL_ESCALATION_MS = 500;

function startLocalExec(
  root: string,
  baseEnv: Record<string, string>,
  opts: ExecStartOpts,
): ExecHandle {
  const cwd = opts.cwd === undefined ? root : resolve(root, opts.cwd);
  // cwd containment is a string-level check here (it must exist to spawn, and
  // spawn itself fails on a missing dir; a symlinked cwd inside the root is
  // within the trusted-dev-code contract of this adapter).
  if (cwd !== root && !cwd.startsWith(`${root}/`)) {
    throw new WorkspaceError(
      "policy",
      `exec cwd ${JSON.stringify(opts.cwd)} escapes the workspace root`,
    );
  }

  const startedAt = Date.now();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    ...baseEnv,
    ...opts.env,
  };

  let killedByCaller = false;
  let timedOut = false;
  const killRef: { current: () => void } = { current: () => undefined };

  const completion = new Promise<ExecCompletion>((resolveCompletion) => {
    const child = spawn("sh", ["-c", opts.command], {
      cwd,
      env,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // New process group so we can signal the whole tree on timeout/kill —
      // Linux's default `child.kill('SIGTERM')` signals only the immediate
      // child (sh), leaving grandchildren orphaned with the stdio pipes held.
      detached: true,
    });

    const tails = {
      stdout: new TailBuffer(opts.maxTailBytes),
      stderr: new TailBuffer(opts.maxTailBytes),
    };
    const onData = (channel: "stdout" | "stderr", chunk: Buffer): void => {
      tails[channel].push(chunk);
      if (opts.onChunk) {
        try {
          opts.onChunk({ channel, text: chunk.toString("utf8") });
        } catch {
          // fire-and-forget: a throwing chunk consumer never affects the exec
        }
      }
    };
    child.stdout?.on("data", (c: Buffer) => onData("stdout", c));
    child.stderr?.on("data", (c: Buffer) => onData("stderr", c));
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);

    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal); // negative PID = whole group
      } catch {
        // group already gone
      }
    };
    const escalate = (): void => {
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), SIGKILL_ESCALATION_MS).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      escalate();
    }, opts.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      killedByCaller = true;
      escalate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    killRef.current = () => {
      killedByCaller = true;
      escalate();
    };

    const finish = (exitCode: number | null, signal: string | null, spawnError?: Error): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (spawnError) tails.stderr.push(Buffer.from(spawnError.message));
      resolveCompletion({
        exitCode,
        signal,
        timedOut,
        killed: killedByCaller,
        tail: {
          stdout: tails.stdout.text(),
          stderr: tails.stderr.text(),
          truncated: tails.stdout.truncated || tails.stderr.truncated,
        },
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (err) => finish(null, null, err));
    child.on("close", (code, signal) => finish(code, signal));
  });

  return {
    execId: opts.execId,
    wait: () => completion,
    kill: () => killRef.current(),
  };
}

function entryType(e: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): DirEntry["type"] {
  if (e.isSymbolicLink()) return "symlink";
  if (e.isDirectory()) return "directory";
  if (e.isFile()) return "file";
  return "other";
}

function wrapFsError(err: unknown, op: string, path: string): Error {
  if (err instanceof WorkspaceError) return err;
  const e = err as NodeJS.ErrnoException;
  return new WorkspaceError(
    "runtime",
    `local adapter ${op}(${JSON.stringify(path)}) failed: ${e.code ?? ""} ${e.message ?? String(err)}`.trim(),
  );
}
