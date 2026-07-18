/**
 * @teaspill/catalog — Postgres catalog schema + migrations (0001:T1.3, 0001:D1).
 *
 * Owner of the 0001:D1 catalog store's shape. Coordination (packages/coordination)
 * writes `entities`/`entity_tags` from inside agent handlers via `ctx.run`;
 * the gateway (packages/gateway) reads `api_keys` for auth and proxies
 * Electric shapes over `entities`/`entity_tags`.
 */

export * from "./schema.js";
export {
  API_KEY_PREFIX,
  newApiKey,
  hashApiKey,
  createApiKey,
  listApiKeys,
  resolveApiKeyRow,
  revokeApiKey,
  classifyKeySelector,
  type ApiKeyListRow,
  type CreatedApiKey,
  type KeySelector,
  type RevokeResult,
} from "./keys.js";
export {
  createCatalogClient,
  getDatabaseUrl,
  migrate,
  MIGRATIONS_FOLDER,
  type CatalogDb,
  type CatalogSchema,
  type CreateCatalogClientOptions,
} from "./client.js";
