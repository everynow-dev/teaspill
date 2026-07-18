# Backup & restore (T8.3)

Scripts: `scripts/backup.sh` / `scripts/restore.sh`. Both are POSIX `sh`,
dependency-light (just `docker` with the `compose` plugin), and documented
inline — this doc is the *story*: what each store owns, how it's backed up
and restored, and — the load-bearing part — **which restore combinations
are clean and which are lossy, and why that's acceptable.**

This is a self-hosting ops doc; it does not restate the architecture. See
`work/plans/0001-build-v1/PLAN.md` §2 D1/D7 and `work/plans/0001-build-v1/DECISIONS.md` D1/D7/A10 for the source-of-truth
model this backup story is built on.

---

## 1. What each store owns (D1)

| Store | Owns | Backup mechanism | Restore mechanism |
|---|---|---|---|
| **Postgres** (catalog) | Registry rows (`url, tenant, type, status, tags, parent, head_seq, snapshot_offset, snapshot_stream_offset`) **and** `archived_snapshot` JSONB — the **archive-of-record** for every entity that has ever archived (D7, A10). | `pg_dump --format=custom` against the live container. MVCC gives a consistent snapshot with no pause. | `pg_restore --clean --if-exists --no-owner` against the live container (drops/recreates objects inside the existing db; no `CREATE DATABASE` privilege needed). |
| **durable-streams** | The **history/telemetry** stream — per-entity timeline events (exactly-once, gapless `seq`, D1/D3) plus the ephemeral `/deltas` and workspace-stdout streams. Append-only, never read for control flow. | Filesystem tar of the `durable_streams_data` volume. The Rust server (`electricax/durable-streams-server-rust:0.1.4`) has no per-stream truncation *or* export/dump API (`docs/streams.md` §4.1) — a volume copy is the only mechanism available. | Stop the container, wipe the volume, extract the tar, restart. |
| **Restate** | The **working set** — live entity K/V per virtual object: `status, seq, outbox[], context[], workspaceRef, subscribers[], parentRef, usage`. This is control-flow state, **not** the archive (D1: "the only store consulted for control flow"; D7: "Restate holds the working set only; it is not the archive"). | Filesystem tar of the `restate_data` volume, taken with the container **stopped** (see §3). | Stop the container, wipe the volume, extract the tar, restart. |

The asymmetry that drives the whole restore-combination story: **Postgres
is durable/archival by design (D7), Restate deliberately is not.** Losing
Restate's data is expected to be survivable for archived entities and lossy
for active ones — that is the point of D7, not a gap in it.

## 2. Restate's own backup guidance (why we do it this way)

Verified live against the current docs at
[docs.restate.dev/server/snapshots](https://docs.restate.dev/server/snapshots)
(fetched 2026-07-17, not from training data, per the T8.3 task constraint):

> "Data backups are primarily used for single-node Restate deployments."
>
> "Backing up the full contents of the Restate base directory will ensure
> that you can recover this state in the event of a server failure."
>
> "We recommend placing the data directory on fast block storage that
> supports atomic snapshots, such as Amazon EBS volume snapshots.
> Alternatively, you can stop the restate-server process, archive the base
> directory contents, and then restart the process."
>
> "You must ensure that only one instance of any given Restate node is
> running when restoring the data store from a backup" — running multiple
> instances risks "a 'split-brain' scenario where different servers process
> invocations for the same set of services, causing state divergence."
>
> Before restoring: the `cluster-name` and `node-name` of the restored data
> must match the running server's config.

Two things follow directly for teaspill's compose stack:

1. **The S3/GCS/Azure "snapshot" feature Restate also ships is for
   multi-node clusters** (it exists to support safe log trimming and fast
   partition failover across nodes) — **not applicable here.**
   `docker-compose.yml` runs Restate as a single node (`--node-name=restate-1`,
   `restate_data` named volume, no `--cluster-name`/object-store config) —
   exactly the deployment shape the docs say data backups (not cluster
   snapshots) are for.
2. We don't have snapshot-capable block storage under a Docker named
   volume by default, so `scripts/backup.sh` takes the second recommended
   path: **stop the process, archive the directory, restart it.** Because
   `restore.sh` restores into the *same* compose stack's volume with the
   *same* `--node-name=restate-1` `docker-compose.yml` already pins, the
   node-name-match and single-instance requirements above are satisfied by
   construction — just don't hand-edit the Restate service's node name
   between backing up and restoring.

## 3. Consistency & ordering

The three stores are independent systems; nothing forces them to be backed
up at exactly the same instant unless you make it so. Two modes:

**Quiesced (default, recommended).** `backup.sh` dumps Postgres first
(always consistent via MVCC — no pause needed for this one, regardless of
mode), then **stops** `restate` and `durable-streams`, tars both volumes,
then restarts them. While stopped, agent wakes in flight fail at the
Restate ingress and are retried by their callers (or picked up on the next
wake) — no invocation is silently lost, only delayed by however long the
tar takes (typically seconds). This produces a true point-in-time backup:
all three stores reflect the same instant, because nothing could write to
two of them during the pause.

**Live (`--live` flag).** Skips the stop/start. Zero downtime, but the
Restate and durable-streams volume copies are each a non-atomic snapshot of
a live, concurrently-written directory, and the three stores' copies land
at slightly different wall-clock instants relative to each other — a
**torn backup**. Concretely this can mean: an event the outbox already
confirmed and trimmed made it into the streams-server copy but the
corresponding Restate K/V mutation (or vice versa) didn't, or the catalog's
`head_seq` is ahead of or behind what the streams copy's tail actually
holds.

What a torn backup costs on restore, precisely:

- **Postgres↔streams skew** (catalog `head_seq`/`snapshot_offset` vs the
  streams copy's actual tail) is exactly the drift class T5.3's reconciler
  (`packages/coordination/src/reconciler.ts`) already exists to detect and
  repair in normal operation — `catalog_lag` (re-upsert `head_seq` via a
  monotonic `GREATEST`) and `stuck_outbox` (re-drive the flush, idempotent)
  both self-heal once the restored stack is running and the reconciler's
  periodic tick samples the affected entities (A9). This is a live,
  ongoing repair loop, not a one-shot fixup — expect it to resolve within
  the reconciler's tick interval after restore, not instantly.
- **Restate's own internal consistency** is *not* covered by that
  mechanism — the reconciler repairs catalog/stream skew relative to
  Restate's live state, it cannot repair Restate's on-disk state itself if
  the tar caught it mid-write. This is exactly why Restate's own docs
  recommend stopping the process for a backup (§2) rather than tar'ing a
  live data directory, and why `--live` is the exception here, not the
  default.

**Recommendation:** use the default (quiesced) mode for anything you'd
actually restore from. `--live` exists for cases where a few seconds of
control-plane pause is unacceptable and you're willing to lean on the
reconciler for the catalog/stream half of the risk — document that
tradeoff for your own deployment if you choose it. An alternative some
deployments may prefer over `--live` (not implemented by this script, but
compatible with it): issue a brief `pause` via the control API (D2's
`pause`/`resume` verb, `packages/coordination/src/control.ts`) across the
entities you care most about instead of stopping the containers — out of
scope here since it requires enumerating entities rather than one
stack-wide operation, but the same "get a quiet instant" principle applies.

## 4. Restore combinations — what's clean, what's lossy

`scripts/restore.sh` restores any subset of the three stores (`--postgres`,
`--streams`, `--restate`, or `--all`). This is the load-bearing section:
know what you're getting before you pick a subset.

### 4.1 All three restored together → full recovery (clean)

The stack comes back exactly as it was at backup time (modulo the
consistency caveats in §3 if the backup was taken `--live`). No special
handling needed. This is the only combination `restore.sh` doesn't print a
"documented-lossy" warning for.

### 4.2 Catalog + streams, WITHOUT Restate → active entities lost, archived entities fine (acceptable, by design)

This is the scenario T8.3 exists to call out explicitly, and it is **not a
bug** — it is D7's lifecycle model working exactly as designed under a
partial restore.

**What survives:** every entity that had **archived** at or before backup
time. Its full state lives in Postgres's `archived_snapshot` JSONB (D7,
A10) — bounded context, usage, subscribers, parentRef, workspaceRef — plus
its terminal `archived` event and `pre_archive` state_snapshot on the
(restored) stream. A message or spawn to that entity's URL after restore
hits `handleMessage`/`handleSpawn` in `packages/coordination/src/agent.ts`,
finds no live Restate K/V (`seq === null` — Restate has no state for that
key because its data dir was never restored), and
**resurrects** via `resurrectFromCatalog`: rehydrates K/V from
`archived_snapshot`, sets `status: "active"`, and continues the `seq`
counter from the catalog's `head_seq + 1` (agent.ts, `resurrectFromCatalog`,
T8.1/A10). From the caller's point of view this is transparent — same as
any other resurrection.

**What's lost:** every entity that was **active or idle (never archived)**
at backup time. Its live working set — conversation context, in-flight
`seq` counter, pending outbox, subscriber list — existed *only* in
Restate's K/V (D1: "the only store consulted for control flow"). With
Restate's data gone, that state is gone. Concretely, here is what happens
to **a message sent to a lost-active entity** after this kind of restore:

1. `handleMessage` sees `seq === null` (fresh/empty K/V for that key — same
   code path a never-spawned entity would hit).
2. It calls `resurrectFromCatalog`, which calls
   `archiveCatalog.loadArchivedSnapshot(ctx, entityId)`.
3. **That returns `null`** — because this entity was never archived, its
   catalog row's `archived_snapshot` column was never written (that column
   is populated only by the `archive` path, T8.1). There is nothing to
   resurrect *from*.
4. `resurrectFromCatalog` returns `false`, and `handleMessage` throws:
   ```
   agent <entityId> has no live state (not spawned, or archived with no resurrectable snapshot)
   ```
   a `restate.TerminalError` — a loud, visible failure, not a silent drop.
   The sender sees the send fail (or, for a `send`-mediated message, a
   dead-letter `error` event lands on the *sender's* timeline per T2.3's
   dead-letter contract — the same path any undeliverable send takes).

The entity's **registry metadata** (its catalog row: `type`, `tags`,
`parent`, `status` as last written, `head_seq`) still exists in Postgres
and is queryable/listable — it just cannot be *woken* again. Its history up
to the last confirmed `seq` is still readable from the restored streams
volume (browsable, not resumable as a live entity). This is the intended
degradation for this combination: **active state is a cache of the working
set, not the archive (D7) — losing the cache without the archive loses
exactly what was never archived, and nothing else.** If this class of loss
is unacceptable for a given deployment, that deployment must always restore
Restate alongside catalog+streams, or shorten the idle-archive window
(`idleArchiveDelayMs`, T8.1/A10) so less state is ever only-in-Restate at
any given moment.

### 4.3 Restate + catalog restored, streams lost → control flow intact, history hole

The inverse: Restate's K/V (live working set) and Postgres (registry +
archives) come back, but durable-streams' data dir doesn't (or is stale).
**Nothing about control flow breaks** — D1 is explicit that streams are
"never read to decide what to do," so agents keep running exactly as
before. What's lost is the *readable history* for the affected window:
UIs/clients doing a mid-stream join or a full-history read will hit a gap.

This is the exact "catastrophic stream loss" scenario D3 and T5.3's
reconciler already have a designed response to: the reconciler's
`unrecoverable` drift class detects that the catalog's confirmed-seq
tracking can't be satisfied against the (rebuilt/empty) stream, and drives
a `state_snapshot(reason: "recovery", historyHole: true)` onto the stream
before normal appending continues (`packages/coordination/src/reconciler.ts`,
A9; the snapshot/historyHole framing itself is `docs/streams.md` §2.2–§3,
frozen in the canonical schema, A5). Readers (the T5.2 frontend reducer)
treat a `historyHole` snapshot as a **sanctioned jump** — not a drift
error — and resume folding from there; the UI can surface "history gap
here" without treating it as corruption. Net effect: **control flow
survives unmodified; the visible timeline has a documented hole instead of
silently pretending nothing happened.**

### 4.4 Any other partial combination

- **Restate only:** control flow "works" but the catalog has no record of
  entities Restate thinks are live — the gateway's `/api/*` routes and any
  catalog-driven listing (`agents ls`, Electric shapes) won't see them.
  Not a supported combination; restore Postgres alongside Restate.
- **Streams only:** history is readable but nothing can be woken (no
  catalog registry row for any entity, no working set). Effectively a
  read-only archive dump. Restore Postgres alongside streams for anything
  operational.

`restore.sh` does not block any of these — it prints a documented-lossy
warning and proceeds, per this doc's descriptions above.

## 5. Running it

```sh
# Full backup of the running compose stack (quiesced, ~seconds of restate/
# durable-streams downtime for a torn-free snapshot):
scripts/backup.sh -d ./backups/2026-07-17

# Zero-downtime, torn-backup-accepted variant:
scripts/backup.sh -d ./backups/2026-07-17 --live

# Full restore (clean recovery):
scripts/restore.sh -d ./backups/2026-07-17 --all

# Partial restore (catalog + streams only — see §4.2 for what this costs):
scripts/restore.sh -d ./backups/2026-07-17 --postgres --streams
```

Both scripts default to compose project `teaspill` (matching `name:
teaspill` in `docker-compose.yml`) and `./docker-compose.yml`; override
with `-p`/`-f` for a non-default project name or compose file location.
Full flag reference is in each script's header comment.

## 6. What was actually verified

This doc and the scripts were validated as follows (2026-07-17):

- **Syntax:** `sh -n`, `dash -n`, and `bash -n` all pass clean on both
  `scripts/backup.sh` and `scripts/restore.sh`.
- **Live round-trip, all three stores, real `docker compose` stack:**
  brought up `postgres` + `restate` + `durable-streams` (images already
  pinned in `docker-compose.yml`: `postgres:17-alpine`,
  `restatedev/restate:1.7.2`,
  `electricax/durable-streams-server-rust:0.1.4`) under an isolated compose
  project. Seeded a test table in Postgres, ran `backup.sh` (quiesced mode
  — confirmed it actually stops and restarts `restate`/`durable-streams`
  around the volume tar), dropped the test table, ran
  `restore.sh --postgres` and confirmed the row came back exactly.
  Separately ran `restore.sh --streams --restate` (stop → wipe volume →
  extract → restart) against both volumes and confirmed both containers
  came back up healthy/serving afterward. Tore the stack down.
- **Not exercised live:** a real multi-entity teaspill deployment (no
  agent-loop/gateway services were running against this stack) — so §4.2's
  and §4.3's *application-level* outcomes (the `TerminalError` message,
  the reconciler's `historyHole` repair) are verified by reading the
  actual implementation (`packages/coordination/src/agent.ts`'s
  `resurrectFromCatalog`/`handleMessage`, `reconciler.ts`'s
  `unrecoverable` class) and cross-referencing T8.1/T5.3's WORKLOG entries
  and passing test suites, not by reproducing the scenario end-to-end
  against a live gateway + agent-loop. A full-stack conformance scenario
  for "restore catalog+streams without Restate, send a message to a
  previously-active entity, assert the TerminalError" would be a natural
  addition to `packages/conformance` (T6.3) if this needs a standing
  regression test — not built here (out of scope for T8.3's S-sized
  backup/restore *story*, flagged as an open question below).

## 7. Open questions

- Whether to add a conformance-kit scenario (§6) asserting the
  catalog+streams-without-Restate degradation end-to-end against a live
  stack, rather than relying on this doc's static code trace.
- `--live` mode's actual torn-window size (how much can realistically
  diverge between the Postgres dump and the two volume tars in practice)
  hasn't been measured under load — the guidance in §3 is structural
  (what *can* go wrong), not empirical (how *much* it does in a given
  deployment's traffic pattern).
- No automated backup scheduling (cron) is provided — `scripts/backup.sh`
  is a manual/ops-triggered primitive; wiring it to a schedule is a
  deployment-specific concern left to whoever self-hosts.
