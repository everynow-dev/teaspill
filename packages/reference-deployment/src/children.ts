/**
 * Real `listChildren` (0002:T4.1 — the 0001:T6.2 "listChildren real impl"
 * deployment seam) over the 0001:D1 catalog.
 *
 * ## The parent-linkage gap this closes (recorded in the T4.1 WORKLOG)
 *
 * The catalog schema has carried `entities.parent` (+ index) since 0001:T1.3,
 * but NO platform writer populates it: the child's first outbox flush upserts
 * `{url, tenant, type, head_seq, status}` only, and `parentRef` lives in the
 * child's Restate K/V / archive snapshot — never the live catalog row. A
 * catalog-backed `listChildren` therefore needs a deployment-side writer.
 *
 * This module provides both halves behind one seam:
 *  - `recordSpawn` — an idempotent parent-linkage upsert the reference tool
 *    client calls in the SAME journaled tool step that fires the spawn
 *    (insert-or-set-parent-once; it never touches the columns the child's own
 *    single-writer flush owns, so there is no writer conflict: the child's
 *    `upsertHead` `onConflictDoUpdate` does not touch `parent`, and this
 *    upsert touches ONLY `parent` on conflict);
 *  - `listChildren` — `SELECT url, type, status FROM entities WHERE parent = $1`
 *    (the `entities_parent_idx` path the schema always intended).
 *
 * Linkage is BEST-EFFORT: a failed `recordSpawn` must never fail the spawn
 * (the spawn's durable send already happened) — callers catch + log, and
 * `listChildren` simply lags until a retry re-records it.
 */

import { asc, eq, sql } from "drizzle-orm";
import { entities, type CatalogDb } from "@teaspill/catalog";
import { parseEntityUrl } from "@teaspill/schema";

export interface ChildRow {
  entityId: string;
  entityType: string;
  status: string;
}

/** Deployment seam so the tool client unit-tests against a fake. */
export interface ChildrenStore {
  /** Record `childUrl`'s parent linkage. Idempotent; parent is set once, never changed. */
  recordSpawn(link: { childUrl: string; parentUrl: string }): Promise<void>;
  /** All catalog rows whose `parent` is `parentUrl`, url-ordered. */
  listChildren(parentUrl: string): Promise<ChildRow[]>;
}

/** Real store over the Drizzle catalog client (`@teaspill/catalog`). */
export function createDrizzleChildrenStore(db: CatalogDb): ChildrenStore {
  return {
    async recordSpawn({ childUrl, parentUrl }): Promise<void> {
      const parsed = parseEntityUrl(childUrl); // throws AddressingError on malformed input
      await db
        .insert(entities)
        .values({ url: childUrl, tenant: parsed.tenant, type: parsed.type, parent: parentUrl })
        .onConflictDoUpdate({
          target: entities.url,
          // Set-once: an existing non-null parent wins (a replayed/duplicate
          // recordSpawn — or a row racing the child's first flush — can never
          // rewrite an established linkage).
          set: { parent: sql`COALESCE(${entities.parent}, ${parentUrl})` },
        });
    },
    async listChildren(parentUrl): Promise<ChildRow[]> {
      const rows = await db
        .select({ url: entities.url, type: entities.type, status: entities.status })
        .from(entities)
        .where(eq(entities.parent, parentUrl))
        .orderBy(asc(entities.url));
      return rows.map((r) => ({ entityId: r.url, entityType: r.type, status: r.status }));
    },
  };
}

/** In-memory store for tests / no-database dev runs. */
export function createMemoryChildrenStore(): ChildrenStore & {
  readonly rows: Map<string, { parentUrl: string; entityType: string; status: string }>;
} {
  const rows = new Map<string, { parentUrl: string; entityType: string; status: string }>();
  return {
    rows,
    async recordSpawn({ childUrl, parentUrl }): Promise<void> {
      const parsed = parseEntityUrl(childUrl);
      const existing = rows.get(childUrl);
      if (existing) return; // set-once
      rows.set(childUrl, { parentUrl, entityType: parsed.type, status: "active" });
    },
    async listChildren(parentUrl): Promise<ChildRow[]> {
      return [...rows.entries()]
        .filter(([, v]) => v.parentUrl === parentUrl)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([url, v]) => ({ entityId: url, entityType: v.entityType, status: v.status }));
    },
  };
}
