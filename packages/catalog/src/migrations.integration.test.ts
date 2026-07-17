import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as rawSql } from "drizzle-orm";

import { createCatalogClient, migrate, type CatalogDb } from "./client.js";
import { entities, entityTags, apiKeys } from "./schema.js";
import type { Sql } from "postgres";

/**
 * Real round-trip against a live Postgres. Skipped unless DATABASE_URL is
 * set — CI/`pnpm test` by default runs the static checks only
 * (schema.test.ts, migrations.test.ts); this suite is for local dev /
 * anyone spinning up `docker compose up postgres` and pointing
 * DATABASE_URL at the published port (see client.ts's header comment for
 * the connection-string shape).
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("migrate() against a live Postgres", () => {
  let db: CatalogDb;
  let sql: Sql;

  beforeAll(async () => {
    ({ db, sql } = createCatalogClient());
    await migrate({ db, sql });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("creates entities/entity_tags/api_keys with the expected columns", async () => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('entities', 'entity_tags', 'api_keys')
      order by table_name, column_name
    `;
    const byTable = new Map<string, string[]>();
    for (const row of cols) {
      const list = byTable.get(row.table_name) ?? [];
      list.push(row.column_name);
      byTable.set(row.table_name, list);
    }
    expect(byTable.get("entities")?.sort()).toEqual(
      [
        "url",
        "tenant",
        "type",
        "status",
        "tags",
        "parent",
        "head_seq",
        "snapshot_offset",
        "snapshot_stream_offset",
        "archived_snapshot",
        "created_at",
        "updated_at",
      ].sort(),
    );
    expect(byTable.get("entity_tags")?.sort()).toEqual(["url", "tag"].sort());
    expect(byTable.get("api_keys")?.sort()).toEqual(
      ["id", "hash", "label", "created_at", "revoked_at"].sort(),
    );
  });

  it("sets REPLICA IDENTITY FULL on entities and entity_tags", async () => {
    const rows = await sql<{ relname: string; relreplident: string }[]>`
      select relname, relreplident
      from pg_class
      where relname in ('entities', 'entity_tags')
    `;
    for (const row of rows) {
      expect(row.relreplident, row.relname).toBe("f"); // 'f' = FULL
    }
  });

  it("round-trips an entity through drizzle, and the updated_at trigger bumps on UPDATE", async () => {
    const url = `/t/default/a/it-test/${crypto.randomUUID()}`;
    const [inserted] = await db
      .insert(entities)
      .values({ url, tenant: "default", type: "it-test" })
      .returning();
    expect(inserted?.headSeq).toBeNull();
    expect(inserted?.status).toBe("active");

    await db.insert(entityTags).values([
      { url, tag: "alpha" },
      { url, tag: "beta" },
    ]);
    const tags = await db
      .select()
      .from(entityTags)
      .where(rawSql`${entityTags.url} = ${url}`);
    expect(tags.map((t) => t.tag).sort()).toEqual(["alpha", "beta"]);

    // sleep past clock granularity so the trigger's `now()` is observably later
    await new Promise((r) => setTimeout(r, 10));
    const [updated] = await db
      .update(entities)
      .set({ headSeq: 0 })
      .where(rawSql`${entities.url} = ${url}`)
      .returning();
    expect(updated?.headSeq).toBe(0);
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      inserted?.updatedAt.getTime() ?? 0,
    );

    // entity_tags cascades on delete
    await db.delete(entities).where(rawSql`${entities.url} = ${url}`);
    const remainingTags = await db
      .select()
      .from(entityTags)
      .where(rawSql`${entityTags.url} = ${url}`);
    expect(remainingTags).toHaveLength(0);
  });

  it("api_keys.hash has a unique index", async () => {
    const hash = `sha256:${crypto.randomUUID()}`;
    await db.insert(apiKeys).values({ hash, label: "it-test" });
    await expect(
      db.insert(apiKeys).values({ hash, label: "duplicate" }),
    ).rejects.toThrow();
  });
});
