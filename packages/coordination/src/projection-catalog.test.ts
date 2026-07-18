/**
 * 0001:T2.2 — catalog head_seq writer tests.
 *
 * The Drizzle round-trip needs a live Postgres and is skipped unless
 * `DATABASE_URL` is set (same gating as @teaspill/catalog's integration
 * tests): `docker compose up -d postgres`, run migrations, then
 * `DATABASE_URL=postgresql://teaspill:teaspill@localhost:5432/teaspill?sslmode=disable`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleOutboxCatalog, createNoopOutboxCatalog } from "./projection-catalog.js";

describe("createNoopOutboxCatalog", () => {
  it("records upserts for assertions", async () => {
    const catalog = createNoopOutboxCatalog();
    await catalog.upsertHead({ entityId: "/t/default/a/x/i-1", headSeq: 3, status: "active" });
    expect(catalog.upserts).toStrictEqual([
      { entityId: "/t/default/a/x/i-1", headSeq: 3, status: "active" },
    ]);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("createDrizzleOutboxCatalog against a live Postgres", () => {
  // Import lazily so the suite loads without a DB driver connection attempt.
  let db: import("@teaspill/catalog").CatalogDb;
  let sql: import("postgres").Sql;
  const url = `/t/default/a/outbox-cat-test/i-${Date.now().toString(36)}`;

  beforeAll(async () => {
    const catalogPkg = await import("@teaspill/catalog");
    const client = catalogPkg.createCatalogClient({ max: 2 });
    db = client.db;
    sql = client.sql;
    await catalogPkg.migrate({ db, sql });
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM entities WHERE url = ${url}`;
      await sql.end();
    }
  });

  it("inserts the row on first upsert, updates monotonically after", async () => {
    const catalog = createDrizzleOutboxCatalog(db);
    await catalog.upsertHead({ entityId: url, headSeq: 0, status: "active" });
    let rows = await sql`SELECT tenant, type, status, head_seq FROM entities WHERE url = ${url}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant: "default",
      type: "outbox-cat-test",
      status: "active",
      head_seq: "0",
    });

    await catalog.upsertHead({ entityId: url, headSeq: 7, status: "idle" });
    rows = await sql`SELECT status, head_seq FROM entities WHERE url = ${url}`;
    expect(rows[0]).toMatchObject({ status: "idle", head_seq: "7" });

    // Monotonic: a replayed (stale) upsert never rewinds head_seq.
    await catalog.upsertHead({ entityId: url, headSeq: 3, status: "idle" });
    rows = await sql`SELECT head_seq FROM entities WHERE url = ${url}`;
    expect(rows[0]).toMatchObject({ head_seq: "7" });
  });
});
