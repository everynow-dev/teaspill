/**
 * `DockerCli` — the thin, fakeable seam the `docker` adapter's lifecycle state
 * machine (docker-adapter.ts) sits on top of. It is the ONLY place that talks
 * to Docker, and it does so by shelling out to the `docker` CLI.
 *
 * ## SECURITY: socket-mount is root-equivalent on the host (T4.2 decision)
 *
 * The compose dev env grants Docker access by MOUNTING THE HOST DOCKER SOCKET
 * (`/var/run/docker.sock`) into the executor container — chosen over
 * Docker-in-Docker for simplicity (see README "Docker access & the socket-mount
 * security tradeoff"). Mounting the socket is **equivalent to giving the
 * executor root on the host**: anything that can reach the socket can start a
 * container that bind-mounts `/` and read/modify any host file. This is
 * acceptable only for the single-tenant, developer-deployed, internal executor
 * (D6/D8 — a tenant is a deployment; the gateway is the trust boundary). For
 * multi-tenant / hostile-code hosting, move to rootless DinD or a VM adapter
 * (E2B/Firecracker) — the reason this seam is kept minimal.
 *
 * ## Why the CLI, not dockerode (the docker-access dependency decision)
 *
 * T4.2's brief allowed either `dockerode` (pinned) or the `docker` CLI, with
 * justification. We shell out to the CLI because:
 *
 *  - **Zero new dependencies.** The exec path reuses the exact host-process
 *    machinery T4.1 already proved (TailBuffer, onChunk fire-and-forget,
 *    SIGTERM→SIGKILL escalation) — a `docker exec` is just another host child
 *    process, and the CLI already demuxes stdout/stderr for us (no framing to
 *    parse, which is the fiddliest part of the dockerode path).
 *  - **The CLI is present wherever the socket is.** The compose executor image
 *    bundles the `docker` client and mounts `/var/run/docker.sock`
 *    (socket-mount decision — see README "Docker access & the socket-mount
 *    security tradeoff"); if the socket is reachable, so is the CLI.
 *  - **A minimal seam keeps E2B/Firecracker slot-in cheap (D4).** The container
 *    primitives below are the whole Docker surface; nothing above this file
 *    knows Docker exists.
 *
 * The interface is deliberately small so the lifecycle state machine can be
 * unit-tested against a fake (docker-lifecycle.test.ts) with no daemon, while
 * the real container behaviors are covered by docker-adapter.test.ts (gated on
 * `isDockerAvailable()`).
 */

import { spawn } from "node:child_process";
import type { ExecCompletion, ExecHandle, ExecOutputChunk } from "./adapter.js";
import { WorkspaceError } from "./errors.js";
import { TailBuffer } from "./tail-buffer.js";

/** Env var carrying a per-exec marker so we can kill ONLY this exec's process tree. */
export const EXEC_MARKER_ENV = "TEASPILL_EXEC_ID";

const SIGKILL_ESCALATION_MS = 500;

// ---------------------------------------------------------------------------
// Seam
// ---------------------------------------------------------------------------

/** Container create spec (the whole Docker surface the adapter needs). */
export interface ContainerCreateSpec {
  name: string;
  image: string;
  /** Named volume mounted at `workingDir` (the persistent, volume-backed root). */
  volumeName: string;
  workingDir: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Hardening / resource knobs (adapter-fixed; see createDockerCli). */
  hostConfig: DockerHostConfig;
}

export interface DockerHostConfig {
  networkMode: "none" | "bridge";
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
}

export interface DockerExecOpts {
  execId: string;
  command: string;
  /** Absolute container path (already contained). Defaults to the container workingDir. */
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  /** Adapter-enforced hard wall-clock timeout (kill-in-container escalation). */
  timeoutMs: number;
  maxTailBytes: number;
  onChunk?: (chunk: ExecOutputChunk) => void;
  signal?: AbortSignal;
}

export interface DockerRunResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface DockerCli {
  /** Reachability probe — surfaces "unavailable" cleanly instead of a deep spawn error. */
  ping(): Promise<void>;
  /** `{ running }` if the container exists, else `null`. */
  inspectContainer(name: string): Promise<{ running: boolean } | null>;
  /** Create the named volume if absent (idempotent). */
  ensureVolume(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /** Create AND start a container. Throws `DockerNameConflictError` if the name is taken. */
  createContainer(spec: ContainerCreateSpec): Promise<void>;
  startContainer(name: string): Promise<void>;
  stopContainer(name: string): Promise<void>;
  removeContainer(name: string): Promise<void>;
  /** Streaming `docker exec` (the workspace command); returns immediately with a handle. */
  startExec(name: string, opts: DockerExecOpts): ExecHandle;
  /** One-off buffered `docker exec` (FS ops + in-container kill). */
  runExec(name: string, cmd: readonly string[], opts?: { stdin?: string }): Promise<DockerRunResult>;
}

/** Thrown by `createContainer` when the name is already in use (a lost create race). */
export class DockerNameConflictError extends Error {
  constructor(name: string) {
    super(`docker container name already in use: ${name}`);
    this.name = "DockerNameConflictError";
  }
}

// ---------------------------------------------------------------------------
// Real CLI implementation
// ---------------------------------------------------------------------------

export interface DockerCliOptions {
  /** `docker` binary (default `"docker"`). */
  bin?: string;
  /** `DOCKER_HOST` override (e.g. a socket path `unix:///var/run/docker.sock`). */
  dockerHost?: string;
  /** Ceiling for control-plane commands (create/inspect/stop/…). Default 30s. */
  controlTimeoutMs?: number;
}

export function createDockerCli(options: DockerCliOptions = {}): DockerCli {
  const bin = options.bin ?? "docker";
  const controlTimeoutMs = options.controlTimeoutMs ?? 30_000;
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.dockerHost !== undefined ? { DOCKER_HOST: options.dockerHost } : {}),
  };

  /** Run a docker control command to completion, buffering output. */
  const control = (args: string[], stdin?: string): Promise<DockerRunResult> =>
    runToCompletion(bin, args, baseEnv, controlTimeoutMs, stdin);

  return {
    async ping(): Promise<void> {
      const r = await control(["version", "--format", "{{.Server.Version}}"]);
      if (r.exitCode !== 0) {
        throw new WorkspaceError(
          "unavailable",
          `docker adapter: cannot reach the Docker daemon (docker version exited ` +
            `${r.exitCode ?? "without a code"}${
              r.stderr.length > 0 ? `: ${r.stderr.toString().trim()}` : ""
            }). Is the daemon running / the socket mounted?`,
        );
      }
    },

    async inspectContainer(name: string): Promise<{ running: boolean } | null> {
      const r = await control(["inspect", "-f", "{{.State.Running}}", name]);
      if (r.exitCode !== 0) return null; // "No such object"
      return { running: r.stdout.toString().trim() === "true" };
    },

    async ensureVolume(name: string): Promise<void> {
      // `docker volume create` is idempotent: it returns the name whether it
      // created or reused the volume.
      const r = await control(["volume", "create", name]);
      if (r.exitCode !== 0) {
        throw new WorkspaceError(
          "runtime",
          `docker adapter: volume create failed: ${r.stderr.toString().trim()}`,
        );
      }
    },

    async removeVolume(name: string): Promise<void> {
      await control(["volume", "rm", "-f", name]); // best-effort
    },

    async createContainer(spec: ContainerCreateSpec): Promise<void> {
      const args = ["run", "-d", "--name", spec.name];
      // Volume-backed working dir: files under workingDir persist across the
      // container's stop/remove (the volume outlives the container) — the
      // "persist across execs within a workspace's life" guarantee.
      args.push("-v", `${spec.volumeName}:${spec.workingDir}`);
      args.push("-w", spec.workingDir);
      // Hardening (adapter-fixed; no caller surface). Ported from electric's
      // HostConfig: drop caps, no-new-privileges, no swap, resource caps.
      args.push("--cap-drop", "ALL");
      args.push("--security-opt", "no-new-privileges");
      args.push("--pids-limit", String(spec.hostConfig.pidsLimit));
      args.push("--memory", String(spec.hostConfig.memoryBytes));
      args.push("--memory-swap", String(spec.hostConfig.memoryBytes));
      args.push("--cpus", nanoCpusToCpus(spec.hostConfig.nanoCpus));
      args.push("--network", spec.hostConfig.networkMode);
      for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
      for (const [k, v] of Object.entries(spec.labels)) args.push("--label", `${k}=${v}`);
      args.push(spec.image);
      // Keepalive PID 1: the container lives between execs until idle teardown.
      args.push("sh", "-c", "while true; do sleep 3600; done");

      const r = await control(args);
      if (r.exitCode !== 0) {
        const stderr = r.stderr.toString();
        if (/already in use/i.test(stderr)) throw new DockerNameConflictError(spec.name);
        throw new WorkspaceError(
          "runtime",
          `docker adapter: container create failed: ${stderr.trim()}`,
        );
      }
    },

    async startContainer(name: string): Promise<void> {
      const r = await control(["start", name]);
      if (r.exitCode !== 0) {
        throw new WorkspaceError(
          "runtime",
          `docker adapter: container start failed: ${r.stderr.toString().trim()}`,
        );
      }
    },

    async stopContainer(name: string): Promise<void> {
      // `-t 0` → straight to SIGKILL: PID 1 is `sh` (ignores SIGTERM) and holds
      // no state outside its filesystem, so a graceful stop only wastes the
      // timeout.
      await control(["stop", "-t", "0", name]); // best-effort (may already be stopped)
    },

    async removeContainer(name: string): Promise<void> {
      await control(["rm", "-f", name]); // best-effort (idempotent)
    },

    startExec(name: string, opts: DockerExecOpts): ExecHandle {
      return startDockerExec(bin, baseEnv, name, opts, (cmd) =>
        runToCompletion(bin, ["exec", name, ...cmd], baseEnv, controlTimeoutMs),
      );
    },

    async runExec(
      name: string,
      cmd: readonly string[],
      opts?: { stdin?: string },
    ): Promise<DockerRunResult> {
      const args = ["exec", ...(opts?.stdin !== undefined ? ["-i"] : []), name, ...cmd];
      return runToCompletion(bin, args, baseEnv, controlTimeoutMs, opts?.stdin);
    },
  };
}

/**
 * Cheap probe used to GATE the real-container integration tests (skip when the
 * daemon is absent so CI stays green, mirroring the durable-streams integration
 * tests). Never throws.
 */
export async function isDockerAvailable(options: DockerCliOptions = {}): Promise<boolean> {
  try {
    await createDockerCli({ ...options, controlTimeoutMs: options.controlTimeoutMs ?? 4000 }).ping();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Streaming `docker exec` (reuses the T4.1 host-process machinery)
// ---------------------------------------------------------------------------

/**
 * Start a streaming `docker exec`. The `docker` CLI demuxes stdout/stderr onto
 * the client child's own streams, so we tail + forward chunks exactly like the
 * `local` adapter. Kill escalates IN-CONTAINER: every process spawned by this
 * exec inherits a unique marker env var, and `killInContainer` scans
 * `/proc/<pid>/environ` for it — so a timeout/kill fells only THIS exec's tree
 * (PID 1 and any siblings survive), then also kills the local client as a
 * backstop if the daemon leaks the connection.
 */
function startDockerExec(
  bin: string,
  baseEnv: NodeJS.ProcessEnv,
  containerName: string,
  opts: DockerExecOpts,
  runOneOff: (cmd: string[]) => Promise<DockerRunResult>,
): ExecHandle {
  const startedAt = Date.now();
  let killedByCaller = false;
  let timedOut = false;
  const killRef: { current: () => void } = { current: () => undefined };

  const completion = new Promise<ExecCompletion>((resolveCompletion) => {
    const args = ["exec"];
    if (opts.stdin !== undefined) args.push("-i");
    args.push("-w", opts.cwd ?? "/work"); // cwd is contained upstream by the adapter
    args.push("-e", `${EXEC_MARKER_ENV}=${opts.execId}`);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(containerName, "sh", "-c", opts.command);

    const child = spawn(bin, args, { env: baseEnv, stdio: ["pipe", "pipe", "pipe"] });

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
    else child.stdin?.end();

    // Fell only THIS exec's in-container tree (marker scan), then hard-kill the
    // local client after a grace so wait() can never hang on a leaked stream.
    const killInContainer = (): void => {
      void runOneOff([
        "sh",
        "-c",
        `for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do ` +
          `[ "$p" = 1 ] && continue; ` +
          `tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | ` +
          `grep -qxF "${EXEC_MARKER_ENV}=$1" && kill -KILL "$p" 2>/dev/null; ` +
          `done`,
        "sh",
        opts.execId,
      ]).catch(() => undefined);
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, SIGKILL_ESCALATION_MS).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killInContainer();
    }, opts.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      killedByCaller = true;
      killInContainer();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    killRef.current = () => {
      killedByCaller = true;
      killInContainer();
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn a docker CLI command, buffer stdout/stderr, resolve with the exit code. */
function runToCompletion(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  stdin?: string,
): Promise<DockerRunResult> {
  return new Promise<DockerRunResult>((resolve) => {
    const child = spawn(bin, args, {
      env,
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    if (stdin !== undefined) child.stdin?.end(stdin);

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, timeoutMs);
    timer.unref();

    const done = (exitCode: number | null): void => {
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    };
    child.on("error", (e) => {
      err.push(Buffer.from(String(e.message)));
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

function nanoCpusToCpus(nanoCpus: number): string {
  return (nanoCpus / 1_000_000_000).toString();
}
