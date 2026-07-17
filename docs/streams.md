# Stream layout, snapshots & retention (T5.1)

Status: spec, ready to build against. Owner package for the helpers:
`packages/schema` (`snapshot-policy.ts`, shipped with this doc). Emission
wiring is a later task (T2.1/T8.1); the reconciler is T5.3; the reducer is
T5.2 — this doc is the decision + a small pure helper, no streams-server code.

Implements/depends on: **D1** (streams = authoritative history/telemetry,
append-only, resumable, cacheable; never read for control flow), **D3**
(outbox, snapshot-on-catastrophic-loss), **D7** (archive lifecycle), **R4**
(bulk out-of-band, journal carries refs). Builds ON the FROZEN v1 schema
(DECISIONS **A5**) and the outbox/producer reality (DECISIONS **A6**); changes
no event type. Consolidates the stream paths from `docs/addressing.md` §4 into
one canonical map.

---

## 1. Canonical stream map

Every stream is one durable-streams key = its HTTP path used verbatim
(addressing C1); slashes are structural separators, not a directory tree.
Clients reach each through the gateway at `/streams` + `<path>` (T1.2). All
paths derive purely from the entity url / workspace key via the functions in
`packages/schema` (addressing §9).

| Stream | Server path | One per | Written by | Read by | Guarantee | Derivation |
|---|---|---|---|---|---|---|
| **Timeline** | `/t/<tenant>/agents/<type>/<id>/timeline` | entity | the entity's outbox (T2.2), single idempotent producer | UIs (history + fast-join), reconciler (T5.3) | **exactly-once, 0-based gapless seq** (A1/A6) | `timelineStreamPath(url)` |
| **Deltas** (sibling) | `/t/<tenant>/agents/<type>/<id>/deltas` | entity | the live harness run, fire-and-forget `emitDelta` (T3.1) | UIs, live entities only | **best-effort, droppable, no seq** (deltas.ts) | `deltasStreamPath(url)` |
| **Workspace stdout** | `/t/<tenant>/workspaces/<name>/stdout` | workspace | executor host, chunked (T4.1) | UIs / logs | best-effort telemetry | `workspaceStdoutStreamPath(key)` |
| **Per-exec stdout** | `/t/<tenant>/workspaces/<name>/exec/<execId>/stdout` | exec run | executor host, chunked (T4.1) | UIs / logs; `tool_result.detail.streamRef` points here | best-effort telemetry | `workspaceExecStdoutStreamPath(key, execId)` |

Notes that bind the map:

- **Timeline vs deltas is a two-stream split by GUARANTEE, not a style
  choice** (deltas.ts, frozen). The timeline is the single-producer,
  exactly-once, gapless authoritative history (A6). Deltas are the ephemeral,
  droppable, no-seq live channel — a *second, non-idempotent* writer that must
  never share the timeline's producer stream (it would either forge seq slots
  or create the gaps C4 rejects). This split is also what lets retention
  diverge (§4): deltas can be expired wholesale; the timeline cannot.
- **Workspace streams are keyed by workspace, not entity** (a workspace may be
  shared and outlives one run — D4). Per-exec granularity is T4.1's choice;
  both derivations exist. Bulk stdout goes here so the Restate journal and the
  `tool_result` event stay bounded (R4); the finalized `tool_result` carries a
  `tailBytes` cap + a `streamRef` into the per-exec stream.
- **Reader dedup is unchanged by snapshots (A6).** A server crash can readmit
  an already-acked append as a same-seq duplicate record; readers dedup by the
  embedded canonical `seq` and "finalized event wins" (T5.2 reducer). A
  `state_snapshot` is just another record occupying a seq slot — it is deduped
  by its `seq` exactly like every other event and does not perturb this rule.
- **Streams are never read to decide control flow (D1).** The timeline is
  history/fast-join for UIs and drift-checking for T5.3; recovery reads
  Postgres (D7), not the stream.

---

## 2. Snapshot cadence policy

A `state_snapshot` event carries the complete materialized entity state and,
per A5, snapshot@N asserts *"state after consuming all events with `seq <= N`"*
— so a joiner initializes from it and consumes N+1, N+2, … (§3). The payload's
`reason` is one of `periodic | pre_archive | recovery` (frozen enum). This
policy decides WHEN each is emitted and WHO emits it.

### 2.1 Who emits, and when in the handler

**The agent virtual object emits, at outbox time** — never a harness. Harnesses
produce `TimelineEventInit` with no seq; only the single-writer entity handler
allocates seq (A1, `finalizeEvent`). So the snapshot decision lives exactly
where seq is allocated: after a wake's events are staged and about-to-flush
(T2.2 `stage`/`flush`), the handler asks `shouldSnapshot(...)` and, if true,
stages a `state_snapshot` as the next seq slot before flushing. This keeps the
snapshot atomic with the events it summarizes and keeps it gapless.

> This doc SPECIFIES the trigger; the wiring into `agent.ts` is a later task
> (T2.1 for the periodic/recovery call sites, T8.1 for pre_archive). Do not
> read this as coordination code.

### 2.2 The three triggers

1. **`periodic`** — cadence-driven, this module's thresholds
   (`DEFAULT_SNAPSHOT_POLICY`): emit once **≥ 200 seq slots** OR **≥ 256 KiB of
   canonical-event bytes** have accumulated since the last snapshot, subject to
   a `minSeqInterval` floor (≥ 1) so a burst of large payloads can't fire twice
   at the same seq. Either trigger crossing fires; a `0` threshold disables
   that trigger. The byte trigger exists because a few large tool results can
   dwarf the event count — both bound a mid-stream joiner's replay cost. The
   outbox already knows the serialized byte size at append time (R4), so no
   extra accounting is needed. Evaluated per wake at the flush boundary.
2. **`pre_archive`** (D7 / T8.1) — written immediately before the terminal
   `archived` event, so the archived episode's final state is fast-joinable
   from the stream and `archived.payload.snapshotSeq` points at it. **Always
   emitted** (forced — ignores thresholds and the floor).
3. **`recovery`** (D3 / T5.3) — on catastrophic stream loss or unrecoverable
   drift, the reconciler drives a `state_snapshot` (usually with
   `historyHole: true`) then continues. **Always emitted** (forced).

`shouldSnapshot({ seqSinceLastSnapshot, bytesSinceLastSnapshot, reason }, policy)`
funnels all three: forced reasons short-circuit to `true`; `periodic`/omitted
evaluates the thresholds. One call site, one decision function.

### 2.3 Catalog `snapshot_offset` ↔ the snapshot's seq (fast-join contract)

- The catalog `entities.snapshot_offset` column (T1.3) records the **latest
  `state_snapshot` event's position** for an entity — its canonical `seq` is
  the load-bearing value (the stream byte-offset, if also stored, is a
  convenience for a ranged read). It is updated in the same `ctx.run` that the
  outbox already uses to upsert `head_seq` (A6), whenever a `state_snapshot` is
  flushed. Like `head_seq`, treat it as a **monotonic floor** under a crash
  between stream-trim and catalog-upsert (A6 #5): a `GREATEST` upsert, never a
  blind overwrite; the reconciler (T5.3) tightens it.
- **Fast-join** (T5.2): read `snapshot_offset` → load the `state_snapshot` at
  that seq → initialize state from `payload.state` → consume from
  `snapshot_offset + 1`. That "+1" is A5's inclusive contract, provided as
  `fastJoinFromSeq(snapshot)` and fed straight into
  `checkSeqContiguity(events, { expectedFirstSeq })` — a gap there is drift
  (D3), except across a `historyHole` snapshot (no gap-check upstream of it).
- **Selection** when a joiner or the reconciler has several candidate snapshots
  (e.g. scanning the stream rather than trusting the catalog):
  `selectFastJoinSnapshot(candidates)` picks the greatest-`seq` one (fewest
  events to replay); a `historyHole` candidate is NOT excluded — it is the
  correct, often only, join point after a recovery. `null` ⇒ join from seq 0
  (the full timeline, which by A1 begins with `entity_spawned`).

These helpers live in `packages/schema/src/snapshot-policy.ts`; the existing
`checkSeqContiguity` (events.ts) remains the gap detector — this module adds
only the *selection* + the *emit decision*, both pure.

---

## 3. Snapshots do not change reader semantics (cross-ref A6)

A `state_snapshot`:
- occupies a seq slot like any event (A1) — it never skips or resets seq in
  normal operation;
- is deduped by its embedded `seq` on read, exactly like every other record
  (A6 #2) — the server's debounced producer-dedup window applies to it too;
- mutates nothing (state as-of N == state as-of N-1); the INCLUSIVE phrasing is
  purely a join convenience (A5);
- for context assembly is skipped — snapshots carry *materialized entity
  state*, not conversation context; the context fold is driven by
  `summarization` events (A5), a separate mechanism.

The only seq discontinuity a snapshot is ever associated with is a *deliberate*
producer-epoch reset after catastrophic stream loss (A6 #6 / addressing §7):
append a `recovery` snapshot with `historyHole: true`, bump `Producer-Epoch`,
restart `Producer-Seq` at 0 — never leave a gap. That path is T5.3's to build;
`snapshot-policy.ts` only decides the snapshot is due.

---

## 4. Retention / compaction stance for v1

**Stance: adopt the documented "streams grow; the archive lifecycle closes
them per entity; monitor total disk" position — because the Rust server has NO
per-stream prefix truncation. It DOES have whole-stream lifecycle controls
(TTL / expiry / delete) that we use on the ephemeral streams.**

### 4.1 What the `:0.1.4` Rust server actually supports (evidence)

Read from the pinned server source in `../electric` at HEAD
(`packages/durable-streams-rust`, the 0.1.4 source per A6; changelog top =
`0.1.4`) and its README. Retention-relevant capabilities:

- **Whole-stream TTL / expiry — EXISTS.** `Stream-TTL` header (seconds, a
  *sliding* TTL reset on access — a read `touch()`es `last_access` for TTL
  streams; `handlers.rs:1129–1136, 1534–1541`) or `Stream-Expires-At`
  (absolute RFC 3339; the two are mutually exclusive, 400 if both —
  `handlers.rs:376–391`). This expires the **entire** stream, not a prefix.
  Listed in the README core protocol as "TTL / expiry".
- **Whole-stream DELETE — EXISTS.** `DELETE <path>` soft-deletes the stream;
  subsequent access returns `410 gone` (`handlers.rs:275, 880–886, 934`).
  0.1.4 made an acked DELETE durable before the 204 (changelog). Also
  whole-stream.
- **Close — EXISTS.** Marks a stream closed (no further appends; readers get
  EOF). A lifecycle marker, not deletion/retention.
- **Tiered storage (`--tier`, off by default) — EXISTS but is NOT retention.**
  With tiering on, the sealed cold prefix is offloaded to object storage and
  the live file's redundant sealed prefix is reclaimed by **compaction**
  (`tier.rs`, `--tier-compact-bytes`, default 64 MiB). Crucially this is
  **transparent**: cold ranges still resolve at the **same logical offsets**
  (served from the blob store), so the stream's **logical length only ever
  grows** — tiering bounds *local hot disk*, never logical history. Readers see
  the full stream regardless. Off by default (`--tier off` ⇒ byte-identical to
  a single-file server).

**What does NOT exist: per-stream prefix truncation** — there is no API to
"drop records with `seq < N`, keep appending from the tail." Compaction is not
that (it never drops logically-visible data); TTL/expiry/delete operate on the
*whole* stream. This matches the PLAN T5.1 anticipation exactly: *"if the Rust
server lacks per-stream truncation, DON'T build it."* So we don't.

### 4.2 The v1 policy per stream

- **Timeline** — **no truncation; grows; bounded per entity by the archive
  lifecycle (T8.1).** The timeline is authoritative history (D1) and is
  browser-readable for idle-but-not-archived agents, so it is **not**
  auto-expired. Its terminal fate is T8.1's call (the archive-of-record is
  Postgres, D7); this doc does not delete it. Per-entity growth is naturally
  bounded because an entity archives after its idle window and stops appending.
  Total growth across entities is an ops concern → **total-disk monitoring in
  T8.2** (add a disk-usage / stream-count metric; the server exposes append and
  read metrics but no per-stream size gauge — track the data dir at the host
  level). For "bounded local disk with long history," `--tier s3` is available
  as an ops lever (keeps full logical history, offloads cold segments); off by
  default, documented for self-hosting, not required for v1.
- **Deltas (sibling)** — **auto-expire via `Stream-TTL` at PUT-create time.**
  Deltas are worthless once the finalized event lands (deltas.ts); the sibling
  stream is the one place a supported whole-stream TTL fits cleanly. Set a
  short sliding TTL when the delta stream is first created (a live entity keeps
  it alive by producing/reading; an idle one lets it lapse). Recommended
  default **6h** (`DELTA_STREAM_TTL_SECONDS`, tunable) — long enough to cover a
  live session and a UI reconnect, short enough to self-clean. This needs no
  application bookkeeping and no compaction protocol (D8 dropped that).
- **Workspace stdout / per-exec stdout** — **also `Stream-TTL` at create.**
  Best-effort telemetry; after the exec completes, the finalized `tool_result`
  carries the tail + a `streamRef`, so the stream is safe to lapse. Recommended
  default **24h** (`WORKSPACE_STREAM_TTL_SECONDS`, tunable). T4.1/T4.2 own the
  create call; this doc records the stance and the knob.

TTL values are deployment knobs, not schema; they live in the emitters
(outbox/harness/executor), not in `packages/schema`. The only invariant this
doc adds: **never TTL/delete the timeline** — it is authoritative and only
T8.1 decides its end of life.

### 4.3 Why this is safe (D-alignment)

- No D-decision is contradicted: D1 keeps the timeline authoritative and
  regenerable-forward; D7 keeps Postgres the archive-of-record; D8 stays clear
  of the dropped stream-as-truth compaction protocol. Expiring deltas/stdout
  loses only droppable telemetry (deltas.ts already declares them droppable).
- The reconciler (T5.3) reads last-confirmed-seq from the catalog
  (`outboxConfirmedSeq` / `head_seq`, A6 #4), not a stream tail scan, so
  retention on the ephemeral streams never interferes with drift detection on
  the timeline.

---

## 5. Open questions / hand-offs

1. **T8.1 (archive):** does the archive path leave the timeline as-is
   (recommended — authoritative history stays readable), set a long
   `Stream-Expires-At`, or `close` it? This doc's stance is *leave it* + write
   `state_snapshot(reason='pre_archive')` then `archived`; confirm when T8.1
   builds. The `pre_archive` snapshot's seq is `archived.payload.snapshotSeq`.
2. **T5.3 (reconciler):** owns the `recovery` snapshot + the producer-epoch
   reset (A6 #6 needs a per-producer offset once `Producer-Seq == seq` identity
   is broken by a reset). `shouldSnapshot(reason:'recovery')` is the emit gate;
   the epoch/offset mechanics are T5.3's.
3. **T5.2 (reducer):** consumes `selectFastJoinSnapshot` + `fastJoinFromSeq` +
   `checkSeqContiguity`; confirm the `historyHole` UX (surface the hole, don't
   gap-check across it).
4. **Delta/workspace TTL defaults** (6h / 24h) are proposals — tune against
   real session lengths in T5.2/T4.2.
5. **`--tier s3`** is documented as an ops lever for bounded local disk; if a
   deployment enables it, T8.2 disk monitoring should watch the object-storage
   bucket too. Not a v1 requirement.
