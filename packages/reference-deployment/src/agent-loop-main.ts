/**
 * Agent-loop entrypoint (0002:T4.1). `node dist/agent-loop-main.js` (host-run)
 * or the `agent-loop` overlay service (docker-compose.overlay.yml, bundled by
 * `pnpm --filter @teaspill/reference-deployment bundle`).
 *
 * Boot order: [migrate catalog] → build → listen → gateway-health wait →
 * register (gateway `/registry/*`) → `scheduleReconcilers` (0002:T2.2).
 */

import { createCatalogClient, migrate } from "@teaspill/catalog";
import { retryWithBackoff } from "@teaspill/cli/register";
import { readAgentLoopEnv } from "./env.js";
import { startAgentLoop } from "./agent-loop.js";

async function main(): Promise<void> {
  if (process.env.TEASPILL_SMOKE === "1") {
    // Image-build bundle check (gateway Dockerfile pattern): the whole import
    // graph loaded fine — exit before touching the network.
    console.error("[agent-loop] smoke ok");
    return;
  }
  const env = readAgentLoopEnv();
  const log = (line: string): void => console.error(line);

  let db;
  if (env.databaseUrl !== undefined) {
    const client = createCatalogClient({ databaseUrl: env.databaseUrl });
    db = client.db;
    if (env.migrate) {
      // Idempotent (drizzle tracks applied migrations); retried because
      // postgres can lag the container start.
      await retryWithBackoff(
        () => migrate(client, env.migrationsDir),
        {
          onRetry: ({ attempt, delayMs, error }) =>
            log(`[agent-loop] migrate failed (attempt ${attempt}): ${String(error)}; retrying in ${delayMs}ms`),
        },
      );
      log("[agent-loop] catalog migrations up to date");
    }
  }

  const { port } = await startAgentLoop({
    port: env.port,
    tenant: env.tenant,
    ingressUrl: env.ingressUrl,
    streamsUrl: env.streamsUrl,
    gatewayUrl: env.gatewayUrl,
    deploymentUrl: env.deploymentUrl,
    ...(env.apiKey !== undefined && { apiKey: env.apiKey }),
    ...(db !== undefined && { db }),
    workspaceAdapter: env.workspaceAdapter,
    reconcilerEnabled: env.reconcilerEnabled,
    ...(env.anthropicApiKey !== undefined && { anthropicApiKey: env.anthropicApiKey }),
    demoCasdkEnabled: env.demoCasdkEnabled,
    ...(env.demoModel !== undefined && { demoModel: env.demoModel }),
    ...(env.casdkSessionDir !== undefined && { casdkSessionDir: env.casdkSessionDir }),
    logger: log,
  });
  log(`[agent-loop] up on :${port}, registered as ${env.deploymentUrl}`);
}

main().catch((err: unknown) => {
  console.error(`[agent-loop] fatal: ${String(err)}`);
  process.exit(1);
});
