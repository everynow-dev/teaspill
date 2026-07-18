/**
 * Deployment bootstrap sequencing (0002:T4.1). ONE load-bearing order, shared
 * by both services and unit-tested (bootstrap.test.ts):
 *
 *   1. LISTEN   — serve the Restate endpoint (the deployment must be up
 *                 before Restate is told to dial it);
 *   2. HEALTH   — wait on gateway `GET /health` with backoff
 *                 (`waitForHealthy`, `@teaspill/cli` — 0001:T6.2's
 *                 register-before-up fix; REUSED, not reinvented);
 *   3. REGISTER — `registerDeployment` through the gateway `/registry/*`
 *                 (0001:T0.4/0001:D4: registration always flows through the
 *                 gateway, never Restate's admin API directly), wrapped in
 *                 `retryWithBackoff`;
 *   4. SCHEDULE — post-registration hooks: the agent-loop kicks 0002:T2.2's
 *                 `scheduleReconcilers(...)` here (idempotent by generation
 *                 supersession; a logged no-op when disabled). Also retried:
 *                 Restate's service discovery of the just-registered
 *                 deployment can lag the registration response.
 *
 * `teaspill dev` performs steps 2–3 too (for host-run deployments, with the
 * `host.docker.internal` default); the overlay services self-sequence the
 * same steps in-network so `docker compose up` alone yields a working stack —
 * both paths are idempotent (`force: true` registration, generation-guarded
 * scheduling).
 */

import { retryWithBackoff, waitForHealthy, type BackoffOptions } from "@teaspill/cli/register";

export interface BootstrapSteps {
  /** Serve the endpoint; resolves with the bound port. */
  listen(): Promise<number>;
  /** Gateway health probe (`createHealthProbe(gatewayUrl)` in production). */
  healthProbe(): Promise<boolean>;
  /** One registration attempt (throws to retry). */
  register(): Promise<void>;
  /** Post-registration hook (reconciler scheduling; optional). */
  schedule?(): Promise<void>;
}

export interface BootstrapOptions {
  backoff?: BackoffOptions;
  logger?: (line: string) => void;
}

export interface BootstrapResult {
  port: number;
}

export async function runBootstrapSequence(
  steps: BootstrapSteps,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const log = opts.logger ?? ((line: string) => console.error(line));
  const backoff = opts.backoff ?? {};

  const port = await steps.listen();
  log(`[bootstrap] endpoint listening on :${port}`);

  await waitForHealthy(steps.healthProbe, {
    ...backoff,
    onRetry: ({ attempt, delayMs }) =>
      log(`[bootstrap] gateway not ready (attempt ${attempt}); retrying in ${delayMs}ms`),
  });
  log("[bootstrap] gateway healthy");

  await retryWithBackoff(() => steps.register(), {
    ...backoff,
    onRetry: ({ attempt, delayMs, error }) =>
      log(`[bootstrap] registration failed (attempt ${attempt}): ${String(error)}; retrying in ${delayMs}ms`),
  });
  log("[bootstrap] deployment registered");

  if (steps.schedule) {
    await retryWithBackoff(() => steps.schedule!(), {
      ...backoff,
      onRetry: ({ attempt, delayMs, error }) =>
        log(`[bootstrap] scheduling failed (attempt ${attempt}): ${String(error)}; retrying in ${delayMs}ms`),
    });
    log("[bootstrap] post-registration scheduling done");
  }

  return { port };
}
