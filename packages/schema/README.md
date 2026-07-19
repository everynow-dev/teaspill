# @teaspill/schema

Canonical timeline event schema (T0.1) and token-delta framing. **STATUS:
PROPOSED, not frozen** — freezes at gate G3 after review of
`work/plans/0001-build-v1/notes/casdk-mapping.md`.

## Design notes (T0.1)

- **Envelope** `{ v, entityId, seq, ts, type, payload }`; `seq` is 0-based and
  gapless per entity (DECISIONS A1 — the durable-streams idempotent producer
  demands it). Every event occupies a seq slot, including `state_snapshot`.
  Harnesses produce `TimelineEventInit` (no `v`/`entityId`/`seq`); the
  entity's outbox is the ONLY seq allocator (`finalizeEvent`).
- **Vocabulary** (15 types): `entity_spawned` (always seq 0), `run_started`,
  `message` (roles `user`/`assistant`/`system_note`), `tool_call`,
  `tool_result`, `reasoning` (display-only), `state_snapshot`,
  `summarization`, `control` (PLAN called it `signal`; renamed per D8),
  `error`, `run_finished`, `child_spawned`, `child_finished`, `archived`
  (episode-terminal; resurrection continues the seq counter), and `opaque`
  (tagged foreign payloads — lossless round-trip for unknown CASDK records,
  R2/R3).
- **Snapshot ↔ seq**: `state_snapshot` at seq N asserts "state after
  consuming all events with seq <= N". Fast-join: init from snapshot, consume
  from N+1 (`checkSeqContiguity({ expectedFirstSeq: N + 1 })`).
- **Summarization ↔ seq**: `replacesThroughSeq = M < N` folds context-bearing
  events `<= M` out of provider context (stream history untouched).
- **Token deltas** (`deltas.ts`): sub-events on the **sibling `/deltas`
  stream** (addressing §4.2), NOT the timeline — they reference a finalized
  event id (`ref`), carry no seq, are best-effort/droppable; the finalized
  event always wins. Rationale in the module header (A1/C4 producer protocol,
  write-path split, retention, cacheability).
- Structural invariants: `checkSeqContiguity`, `checkTimelineInvariants`.

Addressing helpers (the addressing reference, https://teaspill.everynow.dev/reference/addressing) land here via a follow-up task.
