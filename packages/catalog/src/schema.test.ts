import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { apiKeys, entities, entityTags, type NewEntity } from "./schema.js";

describe("entities table shape", () => {
  it("has the columns required by 0001:T1.3", () => {
    const { columns } = getTableConfig(entities);
    const names = columns.map((c) => c.name).sort();
    expect(names).toEqual(
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
  });

  it("has url as the primary key", () => {
    const { columns } = getTableConfig(entities);
    const url = columns.find((c) => c.name === "url");
    expect(url?.primary).toBe(true);
  });

  it("head_seq and snapshot_offset are nullable bigints", () => {
    const { columns } = getTableConfig(entities);
    const headSeq = columns.find((c) => c.name === "head_seq");
    const snapshotOffset = columns.find((c) => c.name === "snapshot_offset");
    expect(headSeq?.notNull).toBe(false);
    expect(snapshotOffset?.notNull).toBe(false);
    expect(headSeq?.columnType).toBe("PgBigInt53");
  });

  it("snapshot_stream_offset is a nullable opaque text offset (0001:T8.1)", () => {
    const { columns } = getTableConfig(entities);
    const col = columns.find((c) => c.name === "snapshot_stream_offset");
    expect(col?.notNull).toBe(false);
    expect(col?.columnType).toBe("PgText");
  });

  it("indexes exist for the documented Electric shape access patterns", () => {
    const { indexes } = getTableConfig(entities);
    const indexNames = indexes.map((i) => i.config.name).sort();
    expect(indexNames).toEqual(
      [
        "entities_tenant_idx",
        "entities_type_idx",
        "entities_parent_idx",
        "entities_status_idx",
      ].sort(),
    );
  });

  it("type-level insert shape accepts a minimal row (typecheck-only assertion)", () => {
    // This is primarily a compile-time check: NewEntity must accept a row
    // supplying only the NOT NULL / no-default columns. Runtime assertion
    // just confirms the object shape round-trips through TS unmodified.
    const row: NewEntity = { url: "/t/default/a/researcher/01j9z8k3q", tenant: "default", type: "researcher" };
    expect(row.url).toBe("/t/default/a/researcher/01j9z8k3q");
  });
});

describe("entity_tags table shape", () => {
  it("has a composite (url, tag) primary key and an fk to entities.url", () => {
    const { columns, primaryKeys, foreignKeys, indexes } =
      getTableConfig(entityTags);
    expect(columns.map((c) => c.name).sort()).toEqual(["url", "tag"].sort());
    expect(primaryKeys).toHaveLength(1);
    expect(
      primaryKeys[0]?.columns.map((c) => c.name).sort(),
    ).toEqual(["url", "tag"].sort());
    expect(foreignKeys).toHaveLength(1);
    const indexNames = indexes.map((i) => i.config.name);
    expect(indexNames).toContain("entity_tags_tag_idx");
  });
});

describe("api_keys table shape", () => {
  it("has the documented columns and a unique index on hash", () => {
    const { columns, indexes } = getTableConfig(apiKeys);
    expect(columns.map((c) => c.name).sort()).toEqual(
      ["id", "hash", "label", "created_at", "revoked_at"].sort(),
    );
    const hashIdx = indexes.find((i) => i.config.name === "api_keys_hash_idx");
    expect(hashIdx?.config.unique).toBe(true);
  });
});
