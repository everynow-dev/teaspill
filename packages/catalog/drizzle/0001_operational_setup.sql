-- 0001_operational_setup.sql (hand-written, drizzle-kit --custom)
--
-- Two things drizzle-kit's schema diff can't express from src/schema.ts:
-- an updated_at trigger, and Electric/logical-replication wiring. Neither
-- changes the table shape, so this rides as its own migration rather than
-- polluting the generated 0000_init.sql.

-- ---------------------------------------------------------------------------
-- 1. updated_at trigger (backstop for src/schema.ts's app-set updatedAt)
-- ---------------------------------------------------------------------------
-- The primary mechanism is app-set: coordination sets `updated_at` itself on
-- every UPDATE inside the same statement as the rest of the row's write (see
-- schema.ts's `updatedAt` column comment) so it lands atomically with
-- whatever else changed under D1's single-writer-via-ctx.run model. This
-- trigger is a server-side backstop for any writer (a manual `psql` fix, a
-- future admin tool) that forgets — it only overrides `updated_at` on rows
-- where the caller didn't already set a newer one than `now()`, so it never
-- fights a deliberate app-set value from a retried/replayed write landing
-- slightly out of wall-clock order.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  IF NEW.updated_at IS NULL OR NEW.updated_at <= OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER entities_set_updated_at
  BEFORE UPDATE ON "entities"
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. REPLICA IDENTITY FULL (Electric requirement, verified against current
--    docs: https://electric.ax/docs/sync/guides/postgres-permissions and
--    https://electric.ax/docs/guides/troubleshooting, 2026-07-17)
-- ---------------------------------------------------------------------------
-- Electric needs the pre-image of updated/deleted rows to compute shape
-- diffs; Postgres only includes non-key columns in the logical-replication
-- stream when REPLICA IDENTITY is FULL (DEFAULT only sends the primary key).
-- Set explicitly and up front here rather than relying solely on Electric's
-- own auto-management (see the publication note below) — cheap, idempotent,
-- and removes any "did the first shape request already fix this up" doubt.
ALTER TABLE "entities" REPLICA IDENTITY FULL;
--> statement-breakpoint

ALTER TABLE "entity_tags" REPLICA IDENTITY FULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Electric publication: relying on Electric's default auto-management,
--    NOT adding tables explicitly here.
-- ---------------------------------------------------------------------------
-- Electric's default (non-ELECTRIC_MANUAL_TABLE_PUBLISHING) mode creates and
-- owns `electric_publication_default` / `electric_slot_default` itself, and
-- ADDs a table to that publication automatically the first time a shape is
-- requested against it -- *provided* the connecting role has CREATE on the
-- database and owns (or can alter) the target table. docker-compose.yml
-- does not set ELECTRIC_MANUAL_TABLE_PUBLISHING, and its `POSTGRES_USER`
-- (default `teaspill`) is both Electric's DATABASE_URL role and the role
-- that runs these migrations, so it owns `entities`/`entity_tags` and the
-- auto-managed path applies cleanly. That is the boring default and this
-- migration does not fight it with an explicit
-- `ALTER PUBLICATION electric_publication_default ADD TABLE ...` (a name
-- Electric may itself rename/reshape, since it considers the publication
-- its own to manage in this mode).
--
-- If a future deployment sets ELECTRIC_MANUAL_TABLE_PUBLISHING=true (a
-- restricted Postgres role with only REPLICATION+SELECT, no table
-- ownership/CREATE), that deployment's operator must run, once, against
-- Postgres directly (not from this package -- it depends on Electric-side
-- config this package doesn't own):
--   CREATE PUBLICATION electric_publication_default FOR TABLE entities, entity_tags;
-- (REPLICA IDENTITY FULL is already satisfied by this migration either way.)
