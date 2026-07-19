# @teaspill/catalog

Postgres catalog schema + migrations (T1.3, D1). Shared owner of the D1
catalog store's shape: coordination writes `entities`/`entity_tags` from
inside agent handlers via `ctx.run`; the gateway reads `api_keys` for auth
and proxies Electric shapes over `entities`/`entity_tags`.

## Tables

- **`entities`** — the entity registry (D1). `url` (pk, canonical entity url
  per the addressing reference, https://teaspill.everynow.dev/reference/addressing) · `tenant` (denormalized from the url, A2) ·
  `type` · `status` (`active | idle | archived`, D7) · `tags` (jsonb,
  whole-row convenience copy — not the tag-filter query path) · `parent`
  (plain reference, not an FK — see schema.ts) · `head_seq` (bigint,
  nullable) · `snapshot_offset` (bigint, nullable, opaque stream offset) ·
  `archived_snapshot` (jsonb, D7 archive-of-record) · `created_at` ·
  `updated_at`.
- **`entity_tags`** — normalized `(url, tag)` pk, FK to `entities.url` on
  delete cascade, indexed on `tag` (A2 / addressing.md §8 Rec 2 — Electric
  `where` clauses want scalar equality, not jsonb containment).
- **`api_keys`** — gateway auth (D6). `id` (uuid) · `hash` (unique) ·
  `label` · `created_at` · `revoked_at` (soft revoke).

## `head_seq` nullability

`head_seq` is `bigint`, **nullable, no default**. `NULL` means "the row
exists (idempotent `INSERT ... ON CONFLICT DO NOTHING` at spawn time, per
addressing.md §3.3) but no event has confirmed onto the outbox yet";
anything else is a real, confirmed 0-based gapless canonical `seq` (A1),
including `0` itself (`entity_spawned`). Defaulting to `0` instead was
rejected: `0` is a meaningful confirmed value here, and collapsing
"not-yet-initialized" into it would make a row that crashed between insert
and first outbox confirm indistinguishable from one that successfully
processed `entity_spawned`.

## Electric publication / REPLICA IDENTITY

Verified against current Electric docs (electric.ax, 2026-07-17):
`REPLICA IDENTITY FULL` is required on any table Electric replicates (it
needs full pre-images for update/delete diffs). Set explicitly in
`drizzle/0001_operational_setup.sql` for both `entities` and `entity_tags`.

Publication membership relies on **Electric's default auto-management**
(`electric_publication_default`/`electric_slot_default`, auto-created and
auto-`ADD TABLE`d on first shape request) rather than an explicit
`ALTER PUBLICATION ... ADD TABLE` — `docker-compose.yml` does not set
`ELECTRIC_MANUAL_TABLE_PUBLISHING`, and the migrating role
(`POSTGRES_USER`) owns these tables, so the auto-managed path applies
cleanly. See the migration file's header comment for the manual-mode
fallback if a future deployment restricts the Postgres role.

## Drizzle vs raw SQL

Drizzle ORM (`drizzle-orm` + `drizzle-kit`), postgres.js driver. Migrations
are checked-in SQL under `drizzle/`:
`0000_init.sql` (drizzle-kit generated from `src/schema.ts`) and
`0001_operational_setup.sql` (hand-written `--custom` migration for the
`updated_at` trigger + `REPLICA IDENTITY FULL`, neither of which
drizzle-kit's schema diff can express).

## Usage

```ts
import { createCatalogClient, migrate, entities, entityTags, apiKeys } from "@teaspill/catalog";

const { db, sql } = createCatalogClient(); // reads DATABASE_URL
await migrate({ db, sql });
```

`DATABASE_URL` is not defined in `.env.example` directly —
`docker-compose.yml` synthesizes it for in-network consumers (electric,
gateway) from `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`. Consumers
inside the compose network get it for free; anything run outside it (CLI,
local tests) must set it explicitly, e.g.
`postgresql://teaspill:teaspill@localhost:5432/teaspill?sslmode=disable`.

## Tests

- `src/schema.test.ts` — structural assertions over the Drizzle table
  config (columns, pk, indexes) + a `NewEntity`-typed insert shape
  (compile-time check).
- `src/migrations.test.ts` — static checks on the checked-in SQL files
  (statement balance, expected tables/columns/trigger/REPLICA IDENTITY
  present). No DB required.
- `src/migrations.integration.test.ts` — real round-trip against a live
  Postgres, gated behind `DATABASE_URL` being set (`describe.skipIf`).
  Verified locally against `docker compose up postgres` (this repo's
  `postgres:17-alpine` service): migration applies and is idempotent on
  re-run, columns match, `REPLICA IDENTITY FULL` confirmed
  (`pg_class.relreplident = 'f'`), the `updated_at` trigger bumps on
  `UPDATE`, `entity_tags` cascades on `entities` delete, and
  `api_keys.hash`'s unique index rejects duplicates. Container + volume
  torn down (`docker compose down -v`) after the run — nothing left
  running.
