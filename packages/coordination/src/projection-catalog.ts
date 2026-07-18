/**
 * 0001:T2.2 — Drizzle-backed `OutboxCatalog` writer (0001:D1: Postgres catalog rows
 * written only from inside agent handlers via `ctx.run`; this module is the
 * function those `ctx.run` closures call).
 *
 * `entities.head_seq` semantics (see @teaspill/catalog schema.ts): the last
 * CONFIRMED canonical seq — written at outbox trim time, so the 0001:T5.3 drift
 * reconciler can compare catalog head_seq vs stream tail without scanning
 * (PLAN 0001:T5.3 anticipate). NULL means "row exists but nothing confirmed yet",
 * distinct from seq 0.
 *
 * The upsert is monotonic (`GREATEST`) as defense in depth: under
 * single-writer the value can never regress, but a replayed catalog step
 * after an interleaved wake would otherwise be able to briefly rewind the
 * publicly-visible row (Electric ships every UPDATE to UIs).
 */

import { eq, sql } from "drizzle-orm";
import { entities, type CatalogDb } from "@teaspill/catalog";
import { parseEntityUrlLite, type ArchiveCatalog, type ArchivedSnapshotRow } from "./agent-seams.js";
import type { AgentRuntimeCtx } from "./agent-runtime.js";
import type { JsonValue } from "@teaspill/schema";
import type { EntityDirectory, EntityDirectoryEntry } from "./messaging.js";
import type {
  OutboxCatalog,
  OutboxCatalogSnapshotUpsert,
  OutboxCatalogUpsert,
} from "./projection-outbox.js";

/** No-op catalog for tests / deployments that wire the catalog elsewhere. */
export function createNoopOutboxCatalog(): OutboxCatalog & {
  upserts: OutboxCatalogUpsert[];
  snapshotUpserts: OutboxCatalogSnapshotUpsert[];
} {
  const upserts: OutboxCatalogUpsert[] = [];
  const snapshotUpserts: OutboxCatalogSnapshotUpsert[] = [];
  return {
    upserts,
    snapshotUpserts,
    async upsertHead(upsert: OutboxCatalogUpsert): Promise<void> {
      upserts.push(upsert);
    },
    async upsertSnapshot(upsert: OutboxCatalogSnapshotUpsert): Promise<void> {
      snapshotUpserts.push(upsert);
    },
  };
}

/**
 * Real catalog writer over the Drizzle client from `@teaspill/catalog`.
 * Insert-or-update: the row may not exist yet (the spawn wake's first flush
 * is the first catalog contact for a new entity), so the upsert carries the
 * full identity columns parsed from the entity url.
 */
export function createDrizzleOutboxCatalog(db: CatalogDb): OutboxCatalog {
  return {
    async upsertHead({ entityId, headSeq, status }: OutboxCatalogUpsert): Promise<void> {
      const parsed = parseEntityUrlLite(entityId);
      if (!parsed) throw new Error(`not a canonical entity url: ${JSON.stringify(entityId)}`);
      await db
        .insert(entities)
        .values({
          url: entityId,
          tenant: parsed.tenant,
          type: parsed.type,
          status,
          headSeq,
        })
        .onConflictDoUpdate({
          target: entities.url,
          set: {
            // GREATEST ignores NULL in Postgres, so a NULL head_seq row
            // takes the new value directly.
            headSeq: sql`GREATEST(${entities.headSeq}, ${headSeq})`,
            status,
            updatedAt: new Date(),
          },
        });
    },
    async upsertSnapshot({
      entityId,
      snapshotSeq,
      snapshotStreamOffset,
    }: OutboxCatalogSnapshotUpsert): Promise<void> {
      const parsed = parseEntityUrlLite(entityId);
      if (!parsed) throw new Error(`not a canonical entity url: ${JSON.stringify(entityId)}`);
      // Monotonic GREATEST on the snapshot seq (0001:A7): a replayed/older snapshot
      // upsert never rewinds the row. The byte offset rides along with the seq
      // it belongs to — only overwritten when this upsert's seq actually wins,
      // so `snapshot_stream_offset` always describes the row's `snapshot_offset`.
      await db
        .insert(entities)
        .values({
          url: entityId,
          tenant: parsed.tenant,
          type: parsed.type,
          snapshotOffset: snapshotSeq,
          ...(snapshotStreamOffset !== undefined && { snapshotStreamOffset }),
        })
        .onConflictDoUpdate({
          target: entities.url,
          set: {
            snapshotOffset: sql`GREATEST(${entities.snapshotOffset}, ${snapshotSeq})`,
            snapshotStreamOffset: sql`CASE WHEN ${snapshotSeq} >= COALESCE(${entities.snapshotOffset}, -1)
              THEN ${snapshotStreamOffset ?? null} ELSE ${entities.snapshotStreamOffset} END`,
            updatedAt: new Date(),
          },
        });
    },
  };
}

/**
 * Real `ArchiveCatalog` (0001:T8.1) over the Drizzle catalog: writes the 0001:D7
 * `archived_snapshot` JSONB at archive time and reads it back (with `head_seq`)
 * for resurrection. Both wrap their query in `ctx.run` (0001:D1: catalog I/O from
 * inside handlers — replay-stable, so a retried wake rehydrates identically).
 */
export function createDrizzleArchiveCatalog(db: CatalogDb): ArchiveCatalog {
  return {
    async persistArchivedSnapshot(
      ctx: AgentRuntimeCtx,
      { entityId, snapshot }: { entityId: string; snapshot: JsonValue; snapshotSeq: number },
    ): Promise<void> {
      await ctx.run("archive-snapshot-persist", async () => {
        // The row already exists (the archive flush upserted head_seq +
        // status=archived just before this); update the JSONB in place.
        await db
          .update(entities)
          .set({ archivedSnapshot: snapshot, updatedAt: new Date() })
          .where(eq(entities.url, entityId));
      });
    },
    async loadArchivedSnapshot(
      ctx: AgentRuntimeCtx,
      entityId: string,
    ): Promise<ArchivedSnapshotRow | null> {
      return ctx.run("archive-snapshot-load", async () => {
        const rows = await db
          .select({
            snapshot: entities.archivedSnapshot,
            headSeq: entities.headSeq,
            status: entities.status,
          })
          .from(entities)
          .where(eq(entities.url, entityId))
          .limit(1);
        const row = rows[0];
        // Resurrect only from a genuinely archived row that carries a snapshot.
        if (!row || row.status !== "archived" || row.snapshot === null) return null;
        return { snapshot: row.snapshot as JsonValue, headSeq: row.headSeq };
      });
    },
  };
}

/**
 * Real `EntityDirectory` (0001:T2.3 dead-letter detection) over the Drizzle
 * catalog: reads `entities.status` by url. The lookup is journaled through
 * `ctx.run` (0001:D1: catalog reads from inside handlers) so the dead-letter
 * verdict is replay-stable — a retried wake sees the same target status and
 * dead-letters (or delivers) identically. Returns `null` when no row exists.
 */
export function createDrizzleEntityDirectory(db: CatalogDb): EntityDirectory {
  return {
    async lookup(ctx: AgentRuntimeCtx, entityId: string): Promise<EntityDirectoryEntry | null> {
      return ctx.run("directory-lookup", async () => {
        const rows = await db
          .select({ status: entities.status })
          .from(entities)
          .where(eq(entities.url, entityId))
          .limit(1);
        const row = rows[0];
        return row ? { status: row.status } : null;
      });
    },
  };
}
