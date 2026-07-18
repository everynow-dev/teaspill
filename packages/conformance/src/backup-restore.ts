/**
 * Backup/restore lossy-combo regression driver (0002:T5.3).
 *
 * 0001:T8.3 shipped `scripts/backup.sh` + `scripts/restore.sh` and the
 * documented restore matrix in `docs/backup-restore.md`, but with NO automated
 * regression for the *lossy* combinations. This module is that regression's
 * plumbing: it SCRIPT-DRIVES the two shell scripts (shells out to
 * `sh scripts/backup.sh` / `sh scripts/restore.sh`) so a live test can
 * reproduce `docs/backup-restore.md` §4.2 end-to-end — restore catalog+streams
 * WITHOUT Restate ⇒ an ACTIVE entity is lost (loud `TerminalError`) while an
 * ARCHIVED entity resurrects fine.
 *
 * GATING (chaos-tier, same discipline as `@teaspill/chaos`): the live test
 * needs BOTH a real docker stack AND permission to shell out to destructive
 * `docker compose` operations (backup.sh stops containers; restore.sh wipes
 * volumes). So it is gated on BOTH:
 *   - `TEASPILL_CHAOS=1`     — opt in to real, destructive container control
 *     (the exact flag `packages/chaos/src/env.ts` gates on), and
 *   - `TEASPILL_STACK_URL`   — the live stack to drive (conformance's gate).
 * With either unset, `readBackupRegressionConfig()` returns `null` and the
 * suite `describe.skipIf`s itself out. Nothing here touches docker at import
 * or construction time — the CLI wrapper is lazy.
 *
 * (Conformance can't import `@teaspill/chaos` — chaos depends on conformance —
 * so the tiny `TEASPILL_CHAOS` flag check is inlined here, mirroring
 * `isFlagEnabled` in chaos's env.ts.)
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readStackConfig, type StackConfig } from "./live.js";

// ---------------------------------------------------------------------------
// The exact terminal-error string the regression pins
// ---------------------------------------------------------------------------

/**
 * The EXACT `restate.TerminalError` message `handleMessage` throws when an
 * entity has no live Restate K/V and no resurrectable catalog snapshot —
 * verified against `packages/coordination/src/agent.ts` (`handleMessage`,
 * line ~1360, 2026-07-18). A never-archived ACTIVE entity hits this after a
 * catalog+streams-WITHOUT-Restate restore (docs/backup-restore.md §4.2).
 *
 * Kept here as the asserted regression constant: it is a loud, visible failure
 * raised SERVER-SIDE in the agent virtual object. If agent.ts's wording ever
 * changes, this constant (and the test asserting it) must change in lockstep —
 * that lockstep IS the regression.
 */
export function noLiveStateTerminalError(entityUrl: string): string {
  return `agent ${entityUrl} has no live state (not spawned, or archived with no resurrectable snapshot)`;
}

// ---------------------------------------------------------------------------
// Config (env-gated, chaos-tier)
// ---------------------------------------------------------------------------

/** Truthy env flag: `1`, `true`, `yes`, `on` (case-insensitive). Mirrors chaos. */
export function isChaosFlagEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export interface BackupRegressionConfig {
  /** The live stack under test (conformance's driver config). */
  stack: StackConfig;
  /** Absolute path to the directory holding backup.sh/restore.sh. */
  scriptsDir: string;
  /** docker compose project name (`-p`); omitted ⇒ script default `teaspill`. */
  composeProject?: string;
  /** Path to docker-compose.yml (`-f`); omitted ⇒ script default (repo root). */
  composeFile?: string;
  /**
   * Optional command that RE-REGISTERS the agent deployment against a freshly
   * restored (empty) Restate. Restoring Restate from an empty snapshot wipes
   * its metadata store — including the agent service deployment registration —
   * so the operator must re-register (T4.1's `teaspill dev`/serve) before any
   * post-restore wake can reach `handleMessage`. See the test's NOTE.
   */
  reregisterCmd?: string;
  /** Per-script-invocation timeout (ms); default 5min (volume tars can be slow). */
  scriptTimeoutMs: number;
}

/** Default scripts dir: the repo-root `scripts/`, resolved from this source file. */
export function defaultScriptsDir(): string {
  // .../packages/conformance/src/backup-restore.ts → repo root is four up.
  return fileURLToPath(new URL("../../../scripts", import.meta.url));
}

/**
 * Resolve the backup-regression config from the environment. Returns `null`
 * (⇒ skip) unless BOTH `TEASPILL_CHAOS` is truthy AND `TEASPILL_STACK_URL` is
 * set. Never throws; never touches docker.
 */
export function readBackupRegressionConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackupRegressionConfig | null {
  if (!isChaosFlagEnabled(env["TEASPILL_CHAOS"])) return null;
  const stack = readStackConfig(env);
  if (stack === null) return null;

  const timeoutRaw = env["TEASPILL_BACKUP_SCRIPT_TIMEOUT_MS"];
  return {
    stack,
    scriptsDir: env["TEASPILL_BACKUP_SCRIPTS_DIR"] ?? defaultScriptsDir(),
    ...(env["TEASPILL_BACKUP_COMPOSE_PROJECT"] !== undefined && {
      composeProject: env["TEASPILL_BACKUP_COMPOSE_PROJECT"],
    }),
    ...(env["TEASPILL_BACKUP_COMPOSE_FILE"] !== undefined && {
      composeFile: env["TEASPILL_BACKUP_COMPOSE_FILE"],
    }),
    ...(env["TEASPILL_BACKUP_REREGISTER_CMD"] !== undefined && {
      reregisterCmd: env["TEASPILL_BACKUP_REREGISTER_CMD"],
    }),
    scriptTimeoutMs: timeoutRaw !== undefined ? Number(timeoutRaw) : 300_000,
  };
}

/** Message shown by a skipped backup-regression suite so the reason is never a mystery. */
export const BACKUP_SKIP_MESSAGE =
  "backup lossy-combo regression skipped — set TEASPILL_CHAOS=1 AND TEASPILL_STACK_URL " +
  "(a real docker stack + destructive container control are required; see docs/backup-restore.md) to run it";

// ---------------------------------------------------------------------------
// CLI wrapper — shells out to scripts/backup.sh and scripts/restore.sh
// ---------------------------------------------------------------------------

/** Which of the three stores to restore (`restore.sh` flags). */
export interface RestoreStores {
  postgres?: boolean;
  streams?: boolean;
  restate?: boolean;
}

/**
 * Thin, lazy wrapper that SCRIPT-DRIVES `scripts/backup.sh` / `scripts/restore.sh`
 * via `execFileSync("sh", [script, ...args])` (no shell interpolation of paths).
 * Runs nothing at construction — every method is an explicit, blocking invocation.
 */
export class BackupRestoreCli {
  readonly #config: BackupRegressionConfig;

  constructor(config: BackupRegressionConfig) {
    this.#config = config;
  }

  #composeArgs(): string[] {
    const c = this.#config;
    return [
      ...(c.composeProject !== undefined ? ["-p", c.composeProject] : []),
      ...(c.composeFile !== undefined ? ["-f", c.composeFile] : []),
    ];
  }

  #run(script: string, args: readonly string[]): string {
    return execFileSync("sh", [`${this.#config.scriptsDir}/${script}`, ...args], {
      encoding: "utf8",
      timeout: this.#config.scriptTimeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** `backup.sh -d <dir> [-p …] [-f …] [--live]`. Captures all three stores. */
  backup(dir: string, opts: { live?: boolean } = {}): string {
    return this.#run("backup.sh", [
      "-d",
      dir,
      ...this.#composeArgs(),
      ...(opts.live === true ? ["--live"] : []),
    ]);
  }

  /**
   * `restore.sh -d <dir> -y [--postgres] [--streams] [--restate]`. Always
   * passes `-y` (non-interactive; the documented-lossy warning still prints).
   * Restoring a strict subset is the whole point of the regression.
   */
  restore(dir: string, stores: RestoreStores): string {
    const flags = [
      ...(stores.postgres === true ? ["--postgres"] : []),
      ...(stores.streams === true ? ["--streams"] : []),
      ...(stores.restate === true ? ["--restate"] : []),
    ];
    if (flags.length === 0) throw new Error("restore(): at least one store must be selected");
    return this.#run("restore.sh", ["-d", dir, "-y", ...this.#composeArgs(), ...flags]);
  }

  /** Run the operator's re-register command (if configured), else a no-op. */
  reregister(): void {
    const cmd = this.#config.reregisterCmd;
    if (cmd === undefined) return;
    execFileSync("sh", ["-c", cmd], {
      encoding: "utf8",
      timeout: this.#config.scriptTimeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
