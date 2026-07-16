/**
 * @teaspill/catalog — Drizzle client + migration runner.
 *
 * `DATABASE_URL` wiring: `.env.example` does not define `DATABASE_URL`
 * literally — `docker-compose.yml` synthesizes it for in-network consumers
 * (electric, gateway) from the `POSTGRES_USER`/`POSTGRES_PASSWORD`/
 * `POSTGRES_DB` vars, e.g.
 * `postgresql://teaspill:teaspill@postgres:5432/teaspill?sslmode=disable`.
 * This package expects the same shape via `process.env.DATABASE_URL` —
 * consuming services (coordination, gateway) get it for free from compose;
 * anything run outside the compose network (CLI, tests against the
 * host-published port) must set it explicitly, e.g.
 * `postgresql://teaspill:teaspill@localhost:5432/teaspill?sslmode=disable`.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as schema from "./schema.js";

export type CatalogSchema = typeof schema;
export type CatalogDb = PostgresJsDatabase<CatalogSchema>;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Path to the checked-in SQL migrations directory. Resolved relative to
 * this module so it works both from `src` (ts-node/tsx, tests) and from
 * `dist` after build (the `drizzle/` folder ships alongside `dist/` per
 * `package.json`'s `files` list, one level up from either).
 */
export const MIGRATIONS_FOLDER = join(__dirname, "..", "drizzle");

export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Expected a postgres connection string " +
        "(see docker-compose.yml's gateway/electric services for the " +
        "shape assembled from POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB).",
    );
  }
  return url;
}

export interface CreateCatalogClientOptions {
  /** Defaults to `getDatabaseUrl()` (reads `process.env.DATABASE_URL`). */
  databaseUrl?: string;
  /** Forwarded to `postgres()` (postgres.js). Defaults keep pooling boring. */
  max?: number;
}

/**
 * Creates a Drizzle client bound to the catalog schema, plus the
 * underlying postgres.js connection (`sql`) for callers that need raw
 * access (e.g. `LISTEN/NOTIFY`, one-off scripts) or need to close the
 * pool explicitly.
 */
export function createCatalogClient(
  options: CreateCatalogClientOptions = {},
): { db: CatalogDb; sql: Sql } {
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl();
  const sql = postgres(databaseUrl, { max: options.max ?? 10 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

/**
 * Runs all pending SQL migrations from `drizzle/` against the given
 * database. Idempotent — drizzle-orm's migrator tracks applied migrations
 * in a `drizzle.__drizzle_migrations` table and skips ones already run.
 *
 * Callers own the connection lifecycle: pass an existing client (e.g. from
 * `createCatalogClient`) or let this create+close a short-lived one.
 */
export async function migrate(
  target?: { db: CatalogDb; sql: Sql },
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const owns = !target;
  const { db, sql } = target ?? createCatalogClient();
  try {
    await drizzleMigrate(db, { migrationsFolder });
  } finally {
    if (owns) await sql.end();
  }
}
