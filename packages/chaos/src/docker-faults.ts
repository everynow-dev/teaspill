/**
 * The fault-DRIVER mechanism (T9.1): shell out to `docker compose` to KILL,
 * STOP, START and RESTART a real stack service mid-flight. This is how the live
 * chaos suites inject each fault (`docker compose kill/stop/up`), per PLAN T9.1.
 *
 * NOTHING here runs unless a live chaos suite (gated on `TEASPILL_CHAOS` +
 * `TEASPILL_STACK_URL`, see `env.ts`) calls it — the controller is lazy and
 * never touches docker at construction. Commands are run with `execFileSync`
 * (no shell interpolation of service names). The compose invocation, working
 * directory and file are all overridable so any deployment topology works.
 *
 * - `kill`  → `docker compose kill <svc>`   — abrupt SIGKILL (models a crash).
 * - `stop`  → `docker compose stop <svc>`   — graceful stop (models a planned
 *                                             restart / rolling deploy).
 * - `start` → `docker compose up -d <svc>`  — bring it back.
 * - `restart` = kill + start (a crash-restart) by default.
 * - `waitHealthy` polls `docker compose ps` until the service is running again.
 */

import { execFile, execFileSync } from "node:child_process";

export interface ComposeControllerOptions {
  /** Compose command, space-split; default `docker compose`. */
  composeCmd?: string;
  /** Working dir the compose file lives in; default `process.cwd()`. */
  cwd?: string;
  /** Optional `-f <file>` compose file path. */
  file?: string;
  /** Per-command timeout (ms); default 60s. */
  timeoutMs?: number;
}

export interface ComposeRunResult {
  /** The exact argv run (for logging / debugging a failed fault injection). */
  argv: readonly string[];
  stdout: string;
}

export class ComposeController {
  readonly #bin: string;
  readonly #baseArgs: readonly string[];
  readonly #cwd: string;
  readonly #file: string | undefined;
  readonly #timeoutMs: number;

  constructor(opts: ComposeControllerOptions = {}) {
    const parts = (opts.composeCmd ?? "docker compose").trim().split(/\s+/);
    this.#bin = parts[0] ?? "docker";
    this.#baseArgs = parts.slice(1);
    this.#cwd = opts.cwd ?? process.cwd();
    this.#file = opts.file;
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
  }

  #args(rest: readonly string[]): string[] {
    return [...this.#baseArgs, ...(this.#file ? ["-f", this.#file] : []), ...rest];
  }

  #run(rest: readonly string[]): ComposeRunResult {
    const argv = this.#args(rest);
    const stdout = execFileSync(this.#bin, argv, {
      cwd: this.#cwd,
      timeout: this.#timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { argv: [this.#bin, ...argv], stdout };
  }

  /** `docker compose kill <svc>` — abrupt SIGKILL, models a crash. */
  kill(service: string): ComposeRunResult {
    return this.#run(["kill", service]);
  }

  /** `docker compose stop <svc>` — graceful stop. */
  stop(service: string): ComposeRunResult {
    return this.#run(["stop", service]);
  }

  /** `docker compose up -d <svc>` — bring the service back detached. */
  start(service: string): ComposeRunResult {
    return this.#run(["up", "-d", service]);
  }

  /** Crash-restart: kill then start (an abrupt restart). */
  restart(service: string): { killed: ComposeRunResult; started: ComposeRunResult } {
    const killed = this.kill(service);
    const started = this.start(service);
    return { killed, started };
  }

  /** Raw `docker compose ps <svc>` output (used by `waitHealthy`). */
  ps(service: string): string {
    return this.#run(["ps", service]).stdout;
  }

  /**
   * Poll `docker compose ps` until the service reports running/healthy, or the
   * timeout elapses. Uses async `execFile` + a small sleep so it never blocks
   * the event loop while a container boots.
   */
  async waitHealthy(service: string, timeoutMs = 30_000, intervalMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const out = await this.#psAsync(service);
      // `docker compose ps` prints a STATUS column; "running"/"healthy" ⇒ up.
      if (/\b(running|healthy)\b/i.test(out) && !/\b(starting|restarting)\b/i.test(out)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `service ${service} not healthy within ${timeoutMs}ms (last ps: ${out.trim() || "<empty>"})`,
        );
      }
      await sleep(intervalMs);
    }
  }

  #psAsync(service: string): Promise<string> {
    const argv = this.#args(["ps", service]);
    return new Promise((resolve) => {
      execFile(
        this.#bin,
        argv,
        { cwd: this.#cwd, timeout: this.#timeoutMs, encoding: "utf8" },
        (_err, stdout) => resolve(stdout ?? ""),
      );
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
