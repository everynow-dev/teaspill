/**
 * Chaos env-gating (T9.1). The failure-injection LIVE suites do two dangerous
 * things CI must never do: they need a real docker compose stack AND they
 * shell out to `docker compose kill/stop/up` (or a process handle) to actually
 * KILL and RESTART services mid-flight. So every live chaos suite is gated on
 * BOTH:
 *
 *   - `TEASPILL_CHAOS=1`     — opt in to real process/container control, and
 *   - `TEASPILL_STACK_URL`   — the live stack to drive (conformance's gate).
 *
 * With either unset, `readChaosConfig()` returns `null` and every live chaos
 * suite `describe.skipIf`s itself out with `CHAOS_SKIP_MESSAGE`. The OFFLINE
 * invariant tests (against the real outbox / executor host + conformance's
 * fakes) never read this — they always run in CI.
 *
 * This mirrors conformance's `readStackConfig` skip-guard discipline (and layers
 * on top of it) so `pnpm test` stays green without a stack.
 */

import { readStackConfig, type StackConfig } from "@teaspill/conformance";
import { ComposeController, type ComposeControllerOptions } from "./docker-faults.js";

/** Truthy env flag: `1`, `true`, `yes`, `on` (case-insensitive). */
export function isFlagEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * The compose/process service NAMES the fault drivers target. The three
 * platform services (`durable-streams`, `restate`, `gateway`) are compose
 * services (see `docker-compose.yml`); the agent-loop and executor are
 * developer-DEPLOYED (D4/D6 — not in the platform compose file), so their
 * "service" is whatever the operator runs them as (a compose service in their
 * own file, or a process). All overridable via env so any deployment topology
 * can be exercised.
 */
export interface ChaosServiceNames {
  /** durable-streams Rust server (compose service, D6). */
  streams: string;
  /** Restate server (compose service, D6). */
  restate: string;
  /** Gateway (compose service, D6 — the single entrypoint). */
  gateway: string;
  /** Agent-loop replica (developer-deployed, D4). */
  agentLoop: string;
  /** Executor host (developer-deployed, D4). */
  executor: string;
}

export const DEFAULT_SERVICE_NAMES: ChaosServiceNames = {
  streams: "durable-streams",
  restate: "restate",
  gateway: "gateway",
  agentLoop: "agent-loop",
  executor: "executor",
};

export interface ChaosConfig {
  /** The live stack under test (conformance's driver config). */
  stack: StackConfig;
  /** The compose controller used to kill/restart services (shells out). */
  compose: ComposeController;
  /** Resolved service names the fault drivers target. */
  services: ChaosServiceNames;
}

/** Shown by a skipped live chaos suite so the reason is never a mystery. */
export const CHAOS_SKIP_MESSAGE =
  "live chaos fault skipped — set TEASPILL_CHAOS=1 AND TEASPILL_STACK_URL (a real docker stack + " +
  "process control are required to inject the fault; see README) to run it";

/**
 * Resolve the live chaos config from the environment. Returns `null` (⇒ skip)
 * unless BOTH `TEASPILL_CHAOS` is truthy and `TEASPILL_STACK_URL` is set. Never
 * throws; never touches docker (the `ComposeController` is lazy — no command
 * runs until a driver method is called).
 */
export function readChaosConfig(env: NodeJS.ProcessEnv = process.env): ChaosConfig | null {
  if (!isFlagEnabled(env["TEASPILL_CHAOS"])) return null;
  const stack = readStackConfig(env);
  if (stack === null) return null;

  const composeOpts: ComposeControllerOptions = {
    ...(env["TEASPILL_CHAOS_COMPOSE"] !== undefined && { composeCmd: env["TEASPILL_CHAOS_COMPOSE"] }),
    ...(env["TEASPILL_CHAOS_COMPOSE_DIR"] !== undefined && { cwd: env["TEASPILL_CHAOS_COMPOSE_DIR"] }),
    ...(env["TEASPILL_CHAOS_COMPOSE_FILE"] !== undefined && { file: env["TEASPILL_CHAOS_COMPOSE_FILE"] }),
  };

  return {
    stack,
    compose: new ComposeController(composeOpts),
    services: {
      streams: env["TEASPILL_CHAOS_STREAMS_SVC"] ?? DEFAULT_SERVICE_NAMES.streams,
      restate: env["TEASPILL_CHAOS_RESTATE_SVC"] ?? DEFAULT_SERVICE_NAMES.restate,
      gateway: env["TEASPILL_CHAOS_GATEWAY_SVC"] ?? DEFAULT_SERVICE_NAMES.gateway,
      agentLoop: env["TEASPILL_CHAOS_AGENT_LOOP_SVC"] ?? DEFAULT_SERVICE_NAMES.agentLoop,
      executor: env["TEASPILL_CHAOS_EXECUTOR_SVC"] ?? DEFAULT_SERVICE_NAMES.executor,
    },
  };
}
