import { describe, expect, it } from "vitest";
import { buildCatalogWhere, catalogShapeUrl, fromSnapshotForRow, toEntityRow } from "./catalog.js";

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
        // Opaque durable-streams byte offset — kept verbatim as TEXT (0001:T8.1).
        snapshot_stream_offset: "0000000000001f40",
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
      snapshotStreamOffset: "0000000000001f40",
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
      snapshot_stream_offset: null,
      created_at: null,
      updated_at: null,
    });
    expect(row.headSeq).toBeNull();
    expect(row.snapshotOffset).toBeNull();
    expect(row.snapshotStreamOffset).toBeNull();
    expect(row.parent).toBe("/t/default/a/root/01p");
  });

  it("keeps snapshot_stream_offset null when the column is absent (pre-0002 rows)", () => {
    // A pre-0002 shape row has no such column at all ⇒ null, never "undefined".
    const row = toEntityRow({
      url: "/t/default/a/researcher/01x",
      tenant: "default",
      type: "researcher",
      status: "active",
      tags: [],
      parent: null,
      head_seq: 3,
      snapshot_offset: 2,
    });
    expect(row.snapshotOffset).toBe(2);
    expect(row.snapshotStreamOffset).toBeNull();
  });
});

describe("fromSnapshotForRow (catalog → createAgentTimeline fast-join wiring, 0001:T8.1)", () => {
  it("returns { seq, offset } when the byte offset is known (cheap seek)", () => {
    expect(fromSnapshotForRow({ snapshotOffset: 15, snapshotStreamOffset: "0x1f40" })).toEqual({
      seq: 15,
      offset: "0x1f40",
    });
  });

  it("returns { seq } only when the byte offset is NULL (scan-from-0 fallback stays)", () => {
    // Pre-0002 rows / never-persisted offsets: the reader scans from the start
    // and the reducer resolves the join at the snapshot's seq floor (0001:A7).
    expect(fromSnapshotForRow({ snapshotOffset: 15, snapshotStreamOffset: null })).toEqual({
      seq: 15,
    });
  });

  it("returns undefined for a never-snapshotted entity (full replay from 0)", () => {
    expect(
      fromSnapshotForRow({ snapshotOffset: null, snapshotStreamOffset: null }),
    ).toBeUndefined();
    // A stray byte offset without a seq is still no fast-join (seq is required).
    expect(
      fromSnapshotForRow({ snapshotOffset: null, snapshotStreamOffset: "0x1f40" }),
    ).toBeUndefined();
  });
});
