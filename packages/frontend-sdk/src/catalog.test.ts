import { describe, expect, it } from "vitest";
import { buildCatalogWhere, catalogShapeUrl, toEntityRow } from "./catalog.js";

describe("buildCatalogWhere", () => {
  it("returns nothing for no filter", () => {
    expect(buildCatalogWhere(undefined)).toEqual({});
    expect(buildCatalogWhere({})).toEqual({});
  });

  it("builds positional-param equalities (never interpolates values)", () => {
    expect(buildCatalogWhere({ type: "researcher" })).toEqual({
      where: "type = $1",
      params: ["researcher"],
    });
    expect(
      buildCatalogWhere({
        tenant: "default",
        type: "researcher",
        parent: "/t/default/a/root/01p",
        status: "active",
      }),
    ).toEqual({
      where: "tenant = $1 AND type = $2 AND parent = $3 AND status = $4",
      params: ["default", "researcher", "/t/default/a/root/01p", "active"],
    });
  });
});

describe("catalogShapeUrl", () => {
  it("targets the gateway /shapes proxy (Electric /v1/shape upstream)", () => {
    expect(catalogShapeUrl("http://gw.test")).toBe("http://gw.test/shapes/v1/shape");
    expect(catalogShapeUrl("http://gw.test/")).toBe("http://gw.test/shapes/v1/shape");
  });
});

describe("toEntityRow", () => {
  it("maps snake_case columns and tolerates bigint/string numerics", () => {
    expect(
      toEntityRow({
        url: "/t/default/a/researcher/01x",
        tenant: "default",
        type: "researcher",
        status: "active",
        tags: ["a"],
        parent: null,
        head_seq: 42n as unknown as string,
        snapshot_offset: "15",
        created_at: "2026-07-17T00:00:00Z",
        updated_at: null,
      }),
    ).toEqual({
      url: "/t/default/a/researcher/01x",
      tenant: "default",
      type: "researcher",
      status: "active",
      tags: ["a"],
      parent: null,
      headSeq: 42,
      snapshotOffset: 15,
      createdAt: "2026-07-17T00:00:00Z",
      updatedAt: null,
    });
  });

  it("keeps null head_seq/snapshot_offset (0001:A6: not-yet-confirmed is not 0)", () => {
    const row = toEntityRow({
      url: "/t/default/a/researcher/01x",
      tenant: "default",
      type: "researcher",
      status: "active",
      tags: [],
      parent: "/t/default/a/root/01p",
      head_seq: null,
      snapshot_offset: null,
      created_at: null,
      updated_at: null,
    });
    expect(row.headSeq).toBeNull();
    expect(row.snapshotOffset).toBeNull();
    expect(row.parent).toBe("/t/default/a/root/01p");
  });
});
