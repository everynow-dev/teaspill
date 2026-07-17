/**
 * T2.2 — Drizzle-backed `OutboxCatalog` writer (D1: Postgres catalog rows
 * written only from inside agent handlers via `ctx.run`; this module is the
 * function those `ctx.run` closures call).
 *
 * `entities.head_seq` semantics (see @teaspill/catalog schema.ts): the last
 * CONFIRMED canonical seq — written at outbox trim time, so the T5.3 drift
 * reconciler can compare catalog head_seq vs stream tail without scanning
 * (PLAN T5.3 anticipate). NULL means "row exists but nothing confirmed yet",
 * distinct from seq 0.
 *
 * The upsert is monotonic (`GREATEST`) as defense in depth: under
 * single-writer the value can never regress, but a replayed catalog step
 * after an interleaved wake would otherwise be able to briefly rewind the
 * publicly-visible row (Electric ships every UPDATE to UIs).
 */

import { eq, sql } from "drizzle-orm";
import { entities, type CatalogDb } from "@teaspill/catalog";
import { parseEntityUrlLite } from "./agent-seams.js";
import type { AgentRuntimeCtx } from "./agent-runtime.js";
import type { EntityDirectory, EntityDirectoryEntry } from "./messaging.js";
import type { OutboxCatalog, OutboxCatalogUpsert } from "./projection-outbox.js";

/** No-op catalog for tests / deployments that wire the catalog elsewhere. */
export function createNoopOutboxCatalog(): OutboxCatalog & {
  upserts: OutboxCatalogUpsert[];
} {
  const upserts: OutboxCatalogUpsert[] = [];
  return {
    upserts,
    async upsertHead(upsert: OutboxCatalogUpsert): Promise<void> {
      upserts.push(upsert);
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
  };
}

/**
 * Real `EntityDirectory` (T2.3 dead-letter detection) over the Drizzle
 * catalog: reads `entities.status` by url. The lookup is journaled through
 * `ctx.run` (D1: catalog reads from inside handlers) so the dead-letter
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
