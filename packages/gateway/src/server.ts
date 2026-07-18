/**
 * Gateway server entrypoint (docker CMD / `pnpm start`).
 *
 * `GATEWAY_SMOKE=1 node server.js` exits 0 immediately after module load —
 * the Dockerfile's build stage uses it to verify the bundle's entire import
 * graph resolves without starting anything.
 */

import { loadConfig } from "./config.js";
import { initTelemetry } from "./otel.js";
import { createAuthenticator, postgresApiKeyStore, type ApiKeyStore } from "./auth.js";
import { buildGateway } from "./app.js";

async function main(): Promise<void> {
  if (process.env.GATEWAY_SMOKE === "1") {
    console.log("gateway smoke: import graph OK");
    return;
  }

  const config = loadConfig();
  const shutdownTelemetry = await initTelemetry({ otlpEndpoint: config.otlpEndpoint });

  let store: ApiKeyStore | null = null;
  let closeDb: (() => Promise<void>) | null = null;
  if (config.databaseUrl) {
    // Lazy import keeps `@teaspill/catalog` (and postgres.js) out of the
    // no-database dev path entirely.
    const { createCatalogClient } = await import("@teaspill/catalog");
    const { db, sql } = createCatalogClient({ databaseUrl: config.databaseUrl });
    store = postgresApiKeyStore(db);
    closeDb = async () => {
      await sql.end();
    };
  } else if (!config.bootstrapApiKey) {
    throw new Error(
      "no API-key source configured: set DATABASE_URL (api_keys table) and/or GATEWAY_BOOTSTRAP_API_KEY — an unauthenticated gateway is not allowed",
    );
  }

  const app = buildGateway(config, {
    authenticator: createAuthenticator({
      store,
      bootstrapApiKey: config.bootstrapApiKey,
    }),
  });

  const stop = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await closeDb?.();
    await shutdownTelemetry();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
