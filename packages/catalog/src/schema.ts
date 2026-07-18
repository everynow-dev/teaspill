/**
 * @teaspill/catalog — Postgres catalog schema (0001:T1.3).
 *
 * Implements 0001:D1's catalog store: entity registry rows written only from
 * inside agent handlers via `ctx.run` (coordination package), synced to UIs
 * via Electric shapes, and the archive-of-record for archived entities
 * (0001:D7). `api_keys` backs gateway auth (0001:D6).
 *
 * DECISIONS 0001:A2 folded in: `entities.tenant` (denormalized from the url pk,
 * addressing.md §8 Rec 1) and a normalized `entity_tags(url, tag)` table
 * (addressing.md §8 Rec 2) instead of filtering the `tags` jsonb column
 * directly — Electric shape `where` clauses want scalar-column equality
 * with positional params, and jsonb containment doesn't fit that shape
 * (confirmed against `../electric/packages/typescript-client/src/types.ts`).
 * `tags` jsonb is kept on `entities` for convenient whole-row reads; tag
 * filters should drive shapes off `entity_tags` instead.
 */

import {
  bigint,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// entities
// ---------------------------------------------------------------------------

/**
 * Entity lifecycle (0001:D7): active -> idle -> archived. `idle` is not currently
 * written by anything in this package — it's reserved for 0001:T8.1's idle-timer
 * self-send — but is part of the type from day one so the column never
 * needs a widening migration.
 */
export const entityStatus = pgEnum("entity_status", [
  "active",
  "idle",
  "archived",
]);

export const entities = pgTable(
  "entities",
  {
    /**
     * Canonical entity url (docs/addressing.md §2): `/t/<tenant>/a/<type>/<id>`.
     * Also `entityId` in every canonical timeline event and the
     * durable-streams outbox Producer-Id (0001:D3). Opaque to SQL — never
     * parsed in a query; every filterable component is its own column
     * below (tenant/type/parent/status), which is the whole point of the
     * addressing scheme (addressing.md §8 closing note).
     */
    url: text("url").primaryKey(),

    /**
     * Denormalized from the url's `/t/<tenant>/...` segment (addressing.md
     * §8 Rec 1, DECISIONS 0001:A2). A single-tenant deployment always writes
     * the deployment's configured tenant (default `"default"`); the
     * column exists so a future multi-deployment merge/migration is a
     * `where tenant = $1` shape, not a text-prefix scan on `url`.
     */
    tenant: text("tenant").notNull(),

    /** The `defineAgent` type name (0001:T6.1) / Restate service discriminator. */
    type: text("type").notNull(),

    status: entityStatus("status").notNull().default("active"),

    /**
     * Convenience whole-row copy of an entity's tags. NOT the query path
     * for tag-filtered Electric shapes (addressing.md §8 Rec 2) — use
     * `entity_tags` for those. Kept in sync by the writer (coordination),
     * not by a DB trigger, so a single `ctx.run` write commits both
     * representations atomically from the caller's perspective.
     */
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),

    /**
     * Parent entity's url, or null for a root entity. Intentionally NOT a
     * foreign key: a child's catalog row can be written before or after
     * its parent's row settles inside a single-writer Restate handler,
     * and the parent may itself be archived/gone by the time a query
     * looks; addressing.md's spawn model treats `parent` as a plain
     * reference, not a referential-integrity edge.
     */
    parent: text("parent"),

    /**
     * 0-based, gapless canonical `seq` (DECISIONS 0001:A1) of the last event
     * this row's projection has confirmed onto the durable-streams
     * outbox (0001:D3). NULL means "row exists (idempotent `INSERT ... ON
     * CONFLICT DO NOTHING` at spawn, addressing.md §3.3) but no event has
     * confirmed yet" — distinct from `0`, which means seq 0
     * (`entity_spawned`) has actually confirmed. Chosen over defaulting
     * to 0 because 0 is a real, meaningful seq value here (0001:A1: every
     * entity's first event occupies seq 0) and collapsing "not yet
     * initialized" into it would make an entity that crashed between row
     * insert and first outbox confirm indistinguishable from one that
     * successfully processed `entity_spawned`. `bigint` (not `integer`)
     * because it is a lifetime monotonic counter; JS `number` mode is
     * fine up to 2^53-1 events per entity, which is not a real ceiling.
     */
    headSeq: bigint("head_seq", { mode: "number" }),

    /**
     * Opaque numeric offset into the entity's timeline stream
     * (docs/addressing.md §4.1) identifying the most recent
     * `state_snapshot` event this row's `archivedSnapshot` (or a live
     * fast-join) was built from (0001:T0.1's snapshot-<->seq framing: "a
     * snapshot event has a seq and asserts state as of seq N"). The
     * catalog treats it as opaque — it is not reinterpreted here, only
     * carried — because whether it is literally the snapshot event's
     * `seq` or a byte/log offset from the streams server is 0001:T5.1's call,
     * not this package's.
     */
    snapshotOffset: bigint("snapshot_offset", { mode: "number" }),

    /**
     * Opaque durable-streams read offset (the `Stream-Next-Offset` value,
     * a string per `@durable-streams/client`) at which the most recent
     * `state_snapshot` record BEGINS on the entity's timeline stream
     * (0001:T8.1). NULL when unknown (older rows / a snapshot whose byte offset
     * the outbox could not determine — best-effort). This is the seek hint
     * 0001:T5.2's `createAgentTimeline({ fromSnapshot: { seq, offset } })` reads
     * so a mid-stream joiner can start the stream read AT the snapshot
     * record instead of scanning from offset 0; `snapshot_offset` (the
     * snapshot's canonical seq) remains the authoritative fast-join anchor
     * and the reducer skips any records below it (0001:A6 #5 floor), so an
     * offset that lands slightly EARLY is harmless — only the byte cost of a
     * few extra records. Stored as text because the offset is opaque to the
     * client (never arithmetic here — only carried), same rationale as
     * `snapshot_offset` being catalog-opaque.
     */
    snapshotStreamOffset: text("snapshot_stream_offset"),

    /**
     * Compact state snapshot written at archive time (0001:D7). NULL for any
     * entity that has never been archived. This is the archive-of-record
     * (0001:D1) — resurrection rehydrates from this column, never from the
     * stream.
     */
    archivedSnapshot: jsonb("archived_snapshot"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * App-set, not trigger-set: the writer (coordination, inside
     * `ctx.run`) sets this explicitly on every UPDATE alongside whatever
     * else changed, so it stays in the same statement/transaction as the
     * rest of the row's write rather than depending on a separate DB-side
     * mechanism. A `BEFORE UPDATE` trigger (`drizzle/0001_updated_at_trigger.sql`)
     * additionally guarantees it server-side as a backstop for any writer
     * that forgets — see that migration's header for why both exist.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Electric shape access patterns (docs/addressing.md §8): every
    // subscription a UI needs is a scalar-column equality filter.
    index("entities_tenant_idx").on(t.tenant),
    index("entities_type_idx").on(t.type),
    index("entities_parent_idx").on(t.parent),
    index("entities_status_idx").on(t.status),
  ],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

// ---------------------------------------------------------------------------
// entity_tags — normalized tag table (DECISIONS 0001:A2 / addressing.md §8 Rec 2)
// ---------------------------------------------------------------------------

export const entityTags = pgTable(
  "entity_tags",
  {
    url: text("url")
      .notNull()
      .references(() => entities.url, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.url, t.tag] }),
    // Electric shape access pattern: "all entities with tag X" is a
    // `where tag = $1` scan of this table (then join back to `entities`
    // by `url` if the shape needs full rows).
    index("entity_tags_tag_idx").on(t.tag),
  ],
);

export type EntityTag = typeof entityTags.$inferSelect;
export type NewEntityTag = typeof entityTags.$inferInsert;

// ---------------------------------------------------------------------------
// api_keys — gateway auth (0001:D6: API keys at the gateway for all server-side
// access; no platform-level permissions/scoping model)
// ---------------------------------------------------------------------------

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Hash of the actual key material (e.g. sha256 hex digest) — the raw
     * key is shown to the developer exactly once at creation and never
     * stored. The gateway hashes an inbound `Authorization` header value
     * with the same function and looks up by this column.
     */
    hash: text("hash").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** NULL = active. Revocation is a soft delete so audit history survives. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.hash)],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
