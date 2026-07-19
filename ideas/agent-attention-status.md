# Idea: agent attention / awaiting-input status

**Status:** evaluating (not planned). Raised 2026-07-19.

Ideas in this directory are candidates we're weighing for implementation — not
committed work. Promote to a `work/plans/NNNN-*/` plan when we decide to build.

## Problem

The `set_status(status)` platform tool exists (`packages/harness-native/src/tools.ts`)
and lets an agent set a short human-facing status line mid-run, but v1 has
**nowhere to durably surface it**: the catalog `entities` table carries only the
`status` enum (`active`/`idle`/`archived`), the event schema is frozen v1 with no
status-line event, and the tool's effect is run-local. So the "status line" the
tool description promises is effectively inert.

The real want (from the product side): **track agents that need a human** —
- an agent *awaiting input* from the user (blocked pending a person), and
- an agent that *surfaced something the user should check*.

These are "needs attention" signals a dashboard should badge and filter.

## Why this belongs on the catalog, not the timeline

- The **timeline** is append-only history and is **frozen v1** — adding a
  status event type is a schema-freeze amendment. A live status is current
  state, not history. Wrong home.
- The **catalog** is the Postgres registry UIs already subscribe to live via
  Electric — "current state a dashboard queries and badges" is exactly its job.
  It is **additively migratable** (not frozen), so a new column needs no freeze
  amendment.

## Proposed shape (structured, not free-text)

Add an attention field to the catalog entity:

```
attention: {
  kind: "awaiting_input" | "needs_review" | null,
  note?: string,       // short human line (what set_status carried)
  since: timestamp
}
```

Structured over raw free-text so UIs can **filter** ("all agents awaiting
input") and **badge** deterministically; `note` keeps the human message.

## Mechanics

- **Set:** a typed tool — `await_input(note?)` / `request_attention(kind, note?)`
  — cleaner than overloading `set_status`. Projects to the catalog via the
  existing outbox projection path (same one that writes `status` / `head_seq`).
- **Clear:** automatically — when the awaited message arrives (next wake) or on
  `finish`. The flag tracks reality, not stale intent.
- **Surface:** Electric already streams the catalog, so UIs badge/notify in real
  time with **no new streaming infra**; `@teaspill/frontend-sdk` `CatalogRow`
  gains the field.
- **Wake-model tie-in:** `awaiting_input` = *idle with a reason* — distinguishes
  "idle, done" from "idle, needs you."

## Open questions

- Keep `set_status` (project its text into `attention.note`) or replace it with
  the typed tool(s)? Leaning: add typed tools, keep `set_status` as a plain note
  setter that also lights `needs_review`.
- Does `kind` need more values (e.g. `error`, `blocked_on_child`)? Start minimal.
- Should clearing be automatic only, or also an explicit `clear_attention`?

## Scope if promoted

Platform work: catalog migration + projection + tool(s) in harness-native +
`CatalogRow` in frontend-sdk + docs. Its own plan (e.g. `0004-*`). Not part of
the docs-site plan (0003).
