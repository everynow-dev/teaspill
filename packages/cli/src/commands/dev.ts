/**
 * `teaspill dev` (aka `platform dev`) — the dev loop (0001:T6.2).
 *
 * SEQUENCING (the load-bearing order, PLAN §5 0001:T6.2 / 0001:D6):
 *   1. `docker compose up -d` — bring up the 0001:T1.1 self-host stack.
 *   2. WAIT on gateway health (`GET /health` 2xx) with exponential backoff.
 *   3. Register the local agent-loop/executor deployment(s) through the gateway
 *      `/registry/deployments` (agents-sdk `registerDeployment`) WITH retry +
 *      backoff — this is the fix for the electric-agents register-before-up
 *      race ("Stream not found" on boot order). Steps 2+3 both retry so a
 *      not-yet-ready gateway or a not-yet-listening deployment never fails the
 *      loop; they just wait.
 *   4. (`--watch`) re-register when the deployment's built output changes.
 *   5. Tail `docker compose logs -f` until interrupted.
 *
 * Steps 1 + 5 shell out to Docker (dev-only/manual — no unit test drives a real
 * daemon); steps 2–4 are fully injectable and covered by register.test.ts +
 * dev.test.ts.
 */

import type { CliDeps } from "../deps.js";
import type { ResolvedConfig } from "../config.js";
import { deploymentUrlWarning, resolveDeploymentUrls } from "../config.js";
import { retryWithBackoff, waitForHealthy } from "../register.js";
import type { RunningProcess } from "../compose.js";

export interface DevFlags {
  /** Deployment URL(s) to register (repeatable). Defaults from env/host.docker.internal. */
  deployment?: string[];
  /** Watch the built output and re-register on change. */
  watch?: boolean;
  /** Directory(ies) to watch (default `["dist"]`). */
  watchPath?: string[];
  /** Explicit compose file path (defaults to docker-compose.yml in cwd). */
  composeFile?: string;
  /** Skip `docker compose up` (infra already running). */
  noCompose?: boolean;
  /** Skip tailing `docker compose logs -f`. */
  noLogs?: boolean;
  /** Backoff tuning (mostly for tests). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function runDev(
  deps: CliDeps,
  config: ResolvedConfig,
  flags: DevFlags = {},
  signal?: AbortSignal,
): Promise<void> {
  const deploymentUrls = resolveDeploymentUrls(flags.deployment);
  const backoff = {
    ...(flags.maxAttempts !== undefined ? { maxAttempts: flags.maxAttempts } : {}),
    ...(flags.baseDelayMs !== undefined ? { baseDelayMs: flags.baseDelayMs } : {}),
    ...(flags.maxDelayMs !== undefined ? { maxDelayMs: flags.maxDelayMs } : {}),
    sleep: deps.sleep,
    ...(signal !== undefined ? { signal } : {}),
  };

  // 1. compose up -----------------------------------------------------------
  if (flags.noCompose !== true) {
    deps.io.err("teaspill dev: starting the self-host stack (docker compose up -d)…");
    const code = await deps.compose.up(
      flags.composeFile !== undefined ? { composeFile: flags.composeFile } : {},
    );
    if (code !== 0 && code !== null) {
      throw new Error(`docker compose up exited with code ${code}`);
    }
  }

  // Warn (never rewrite) on loopback deployment URLs — the host.docker.internal
  // registration stance (work/plans/0001-build-v1/notes/self-hosting-networking.md §3).
  for (const url of deploymentUrls) {
    const warning = deploymentUrlWarning(url);
    if (warning !== null) deps.io.err(`⚠ ${warning}`);
  }

  // 2. wait on gateway health ----------------------------------------------
  deps.io.err(`teaspill dev: waiting for the gateway at ${config.gatewayUrl}…`);
  await waitForHealthy(() => deps.healthProbe(config.gatewayUrl), {
    ...backoff,
    onRetry: ({ attempt, delayMs }) =>
      deps.io.err(`  gateway not ready (attempt ${attempt}); retrying in ${delayMs}ms`),
  });
  deps.io.err("teaspill dev: gateway healthy.");

  // 3. register with backoff ------------------------------------------------
  await registerAll(deps, config, deploymentUrls, backoff);

  // 4. watch-mode re-register ----------------------------------------------
  let watchHandle: { close(): void } | null = null;
  if (flags.watch === true) {
    const paths = flags.watchPath ?? ["dist"];
    deps.io.err(`teaspill dev: watching ${paths.join(", ")} — re-registering on rebuild.`);
    watchHandle = deps.watchForRebuild(paths, () => {
      deps.io.err("teaspill dev: rebuild detected — re-registering.");
      void registerAll(deps, config, deploymentUrls, backoff).catch((e: unknown) =>
        deps.io.err(`⚠ re-registration failed: ${String(e)}`),
      );
    });
  }

  // 5. tail logs ------------------------------------------------------------
  let logsProc: RunningProcess | null = null;
  if (flags.noLogs !== true) {
    deps.io.err("teaspill dev: tailing logs (docker compose logs -f). Ctrl-C to stop.");
    logsProc = deps.compose.logsFollow(
      flags.composeFile !== undefined ? { composeFile: flags.composeFile } : {},
    );
  }

  const cleanup = (): void => {
    watchHandle?.close();
    logsProc?.kill();
  };

  // Stay alive only while there is something to keep running: a log tail to
  // follow, or a watcher to re-register on rebuild. With neither (e.g.
  // `--no-logs` and no `--watch`) the loop's one-shot work is done.
  const stayAlive = logsProc !== null || watchHandle !== null;
  if (!stayAlive) {
    cleanup();
    return;
  }

  await new Promise<void>((resolve) => {
    const done = (): void => {
      cleanup();
      resolve();
    };
    if (signal !== undefined) {
      if (signal.aborted) return done();
      signal.addEventListener("abort", done, { once: true });
    }
    // If the log tail exits on its own, stop waiting too.
    if (logsProc !== null) void logsProc.exit.then(done);
  });
}

async function registerAll(
  deps: CliDeps,
  config: ResolvedConfig,
  deploymentUrls: readonly string[],
  backoff: Parameters<typeof retryWithBackoff>[1],
): Promise<void> {
  for (const deploymentUrl of deploymentUrls) {
    deps.io.err(`teaspill dev: registering deployment ${deploymentUrl}…`);
    const result = await retryWithBackoff(
      () =>
        deps.registerDeployment({
          gatewayUrl: config.gatewayUrl,
          deploymentUrl,
          ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
          agents: [],
        }),
      {
        ...backoff,
        onRetry: ({ attempt, delayMs, error }) =>
          deps.io.err(
            `  registration failed (attempt ${attempt}): ${String(error)}; retrying in ${delayMs}ms`,
          ),
      },
    );
    const types = result.agents.map((a) => a.type).join(", ");
    deps.io.err(`teaspill dev: registered ${deploymentUrl}${types ? ` (${types})` : ""}.`);
  }
}
