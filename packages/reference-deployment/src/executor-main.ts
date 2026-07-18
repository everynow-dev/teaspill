/**
 * Executor-host entrypoint (0002:T4.1). `node dist/executor-main.js`
 * (host-run) or the `executor` overlay service (docker-compose.overlay.yml).
 *
 * Default adapter is `docker` (container per workspace; the overlay mounts
 * the host Docker socket). `TEASPILL_EXECUTOR_ADAPTER=local-unrestricted`
 * opts into direct host exec for socket-less dev — DEV ONLY, doubly gated by
 * the adapter's own `TEASPILL_ALLOW_LOCAL_UNRESTRICTED=1` requirement.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistryConfig } from "@teaspill/executor";
import { readExecutorEnv } from "./env.js";
import { startExecutorHost } from "./executor-host.js";

async function main(): Promise<void> {
  if (process.env.TEASPILL_SMOKE === "1") {
    // Image-build bundle check (gateway Dockerfile pattern).
    console.error("[executor] smoke ok");
    return;
  }
  const env = readExecutorEnv();
  const log = (line: string): void => console.error(line);

  const adapters: AdapterRegistryConfig =
    env.adapter === "local-unrestricted"
      ? { localUnrestricted: { baseDir: join(tmpdir(), "teaspill-workspaces") } }
      : { docker: {} };

  const { port } = await startExecutorHost({
    port: env.port,
    ingressUrl: env.ingressUrl,
    streamsUrl: env.streamsUrl,
    gatewayUrl: env.gatewayUrl,
    deploymentUrl: env.deploymentUrl,
    ...(env.apiKey !== undefined && { apiKey: env.apiKey }),
    adapters,
    logger: log,
  });
  log(`[executor] up on :${port} (adapter ${env.adapter}), registered as ${env.deploymentUrl}`);
}

main().catch((err: unknown) => {
  console.error(`[executor] fatal: ${String(err)}`);
  process.exit(1);
});
