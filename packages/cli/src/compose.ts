/**
 * Docker Compose orchestration + watch-mode for `teaspill dev` (0001:T6.2).
 *
 * `platform dev` wraps the repo's `docker-compose.yml` (0001:T1.1) — the same stack
 * the Makefile's `make dev` brings up, but sequenced with the gateway-health
 * wait + register-with-backoff step (register.ts) and log tailing.
 *
 * All process spawning goes through an injectable `Spawner` so the dev loop's
 * SEQUENCING is testable without Docker; the actual `docker compose up` is a
 * dev-only/manual behavior (noted in the README + WORKLOG) — there is no unit
 * test that shells out to a real daemon.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";

export interface RunningProcess {
  /** Resolves with the process exit code (null if killed by signal). */
  readonly exit: Promise<number | null>;
  /** Terminate the process. */
  kill(signal?: NodeJS.Signals): void;
}

export interface Spawner {
  /** Spawn a command; stdout/stderr inherit the CLI's streams by default. */
  run(
    command: string,
    args: readonly string[],
    opts?: { inherit?: boolean; onLine?: (line: string) => void },
  ): RunningProcess;
}

/** Default spawner over node:child_process. */
export const nodeSpawner: Spawner = {
  run(command, args, opts = {}) {
    const child: ChildProcess = spawn(command, [...args], {
      stdio: opts.inherit === false ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (opts.onLine !== undefined) {
      const emit = opts.onLine;
      const wire = (stream: NodeJS.ReadableStream | null): void => {
        if (stream === null) return;
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            emit(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        });
        stream.on("end", () => {
          if (buf !== "") emit(buf);
        });
      };
      wire(child.stdout);
      wire(child.stderr);
    }
    const exit = new Promise<number | null>((resolve, reject) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", reject);
    });
    return {
      exit,
      kill: (signal) => child.kill(signal),
    };
  },
};

/** Base `docker compose` argv, honoring an explicit compose file path. */
export function composeArgs(composeFile: string | undefined, ...rest: string[]): string[] {
  return composeFile !== undefined ? ["compose", "-f", composeFile, ...rest] : ["compose", ...rest];
}

export interface ComposeOptions {
  spawner?: Spawner;
  composeFile?: string;
  /** docker binary (default "docker"). */
  docker?: string;
}

/** `docker compose up -d` (detached). Resolves when compose returns. */
export async function composeUp(opts: ComposeOptions = {}): Promise<number | null> {
  const spawner = opts.spawner ?? nodeSpawner;
  const proc = spawner.run(opts.docker ?? "docker", composeArgs(opts.composeFile, "up", "-d"));
  return proc.exit;
}

/** `docker compose logs -f` — long-running; returns the handle so callers can kill it. */
export function composeLogsFollow(opts: ComposeOptions = {}): RunningProcess {
  const spawner = opts.spawner ?? nodeSpawner;
  return spawner.run(opts.docker ?? "docker", composeArgs(opts.composeFile, "logs", "-f"));
}

/** `docker compose down`. */
export async function composeDown(opts: ComposeOptions = {}): Promise<number | null> {
  const spawner = opts.spawner ?? nodeSpawner;
  const proc = spawner.run(opts.docker ?? "docker", composeArgs(opts.composeFile, "down"));
  return proc.exit;
}

// ---------------------------------------------------------------------------
// Watch mode — re-register on rebuild
// ---------------------------------------------------------------------------

/**
 * The rebuild trigger contract (documented in the README): `--watch` observes
 * the deployment's BUILT OUTPUT directory (e.g. `dist/`, default `--watch-path`).
 * The CLI does NOT run the build; the developer's own build/bundler writes fresh
 * output there, and any file change under the watched path — debounced — fires
 * `onChange`, which the dev loop wires to re-run registration with backoff (a
 * fresh deployment revision is picked up by Restate on the next invocation).
 */
export interface WatchHandle {
  close(): void;
}

export interface WatchOptions {
  /** Coalesce bursts of change events (ms). Default 300. */
  debounceMs?: number;
  /** Injectable watcher factory (default node:fs.watch, recursive). */
  createWatcher?: (path: string, onEvent: () => void) => { close(): void };
  /** Injectable timer (default setTimeout), returns a cancel fn. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** Watch `paths` for changes; call `onChange` (debounced) on any event. */
export function watchForRebuild(
  paths: readonly string[],
  onChange: () => void,
  opts: WatchOptions = {},
): WatchHandle {
  const debounceMs = opts.debounceMs ?? 300;
  const createWatcher =
    opts.createWatcher ??
    ((path, onEvent) => {
      const w: FSWatcher = watch(path, { recursive: true }, () => onEvent());
      return { close: () => w.close() };
    });
  const schedule =
    opts.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });

  let cancel: (() => void) | null = null;
  const fire = (): void => {
    if (cancel !== null) cancel();
    cancel = schedule(() => {
      cancel = null;
      onChange();
    }, debounceMs);
  };

  const watchers = paths.map((p) => createWatcher(p, fire));
  return {
    close: () => {
      if (cancel !== null) cancel();
      for (const w of watchers) w.close();
    },
  };
}
