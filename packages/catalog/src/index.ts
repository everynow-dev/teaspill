/**
 * @teaspill/catalog — Postgres catalog schema + migrations (T1.3, D1).
 *
 * Owner of the D1 catalog store's shape. Coordination (packages/coordination)
 * writes `entities`/`entity_tags` from inside agent handlers via `ctx.run`;
 * the gateway (packages/gateway) reads `api_keys` for auth and proxies
 * Electric shapes over `entities`/`entity_tags`.
 */

export * from "./schema.js";
export {
  createCatalogClient,
  getDatabaseUrl,
  migrate,
  MIGRATIONS_FOLDER,
  type CatalogDb,
  type CatalogSchema,
  type CreateCatalogClientOptions,
} from "./client.js";
