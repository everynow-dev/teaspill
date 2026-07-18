# @teaspill/coordination

Restate coordination services (Phase 2): the agent virtual object template
(T2.1), the projection outbox (T2.2), cron (T2.4), and — landing via their
own tasks — messaging/pub-sub (T2.3), control API (T2.5), steerbox (T2.6).

## Design note — T2.1 agent virtual object (`src/agent.ts` + helpers)

**Template → type.** `createAgentObject(config)` builds ONE Restate virtual
object named `agent.<type>` (A3), keyed by instance id. T6.1's `defineAgent`
specializes the template by supplying the config: `entityType`, `Harness`
(D5), tools, spawn/message validators, and the real seam implementations.
T2.1 ships stub seams so the template runs today; the template itself does
not change when the real seams land.

**Handlers.** `spawn` (first wake; `entity_spawned` at seq 0; idempotent
reattach on re-spawn), `message` (ordinary wake; typed variants for
`child_finished` and `subscription_update` deliveries), `signal` (SHARED —
see below), `archiveTick` (D7 idle check, generation-guarded like cron;
archive body is T8.1, its seq/head_seq contract is documented at
`handleArchiveTick`).

**K/V layout** (documented key-by-key at `AGENT_KV` in `agent-runtime.ts`):
`status, seq, outbox[], context[], workspaceRef, subscribers[], parentRef,
usage, currentInvocationId?` per PLAN/D2, plus two additive keys demanded by
frozen contracts: `harness` (D5 layer-2 continuation state,
`HarnessStateDelta.harness`) and `archiveEpoch` (D7 idle-timer generation
guard).

**Seams (the contracts T2.2/T2.3 inherit)** — `src/agent-seams.ts`:

- `ProjectionOutbox` (T2.2): `stage(ctx, entityId, inits) → TimelineEvent[]`
  is the ONLY seq allocator in the system (A1) — pure K/V, atomic with the
  invocation under single-writer; `flush(ctx, entityId) → {appended,
headSeq}` drains the pending outbox to the stream via the idempotent
  producer inside `ctx.run` steps, replaying IN ORDER from the first
  unconfirmed, trimming only after confirm, upserting catalog `head_seq`.
  The stub (`InMemoryProjectionOutbox`) enforces the C4 producer rules
  (duplicate = no-op, gap = reject) so A1 is a live assertion in tests.
- `AgentNotifier` (T2.3): fire-and-forget durable sends —
  `notifySubscribers` and `notifyParent(child_finished)`. T2.3 adds
  debounce, dead-letter (`error` on the SENDER's timeline), `send`, and
  subscription management; the delivered payload shapes are the
  `AgentMessageInput` variants.

**R4/A4 chunking.** `commitEventsChunked` interleaves bounded `stage`+`flush`
slices (default 16 events) so a large harness event array never produces an
oversized journal entry or K/V value (budget ≤ ~1 MiB; 32 MiB is a
replay-wedging cliff).

**Interrupt seam (A4, verbatim from SPIKE §a).** The object registers with
`explicitCancellation: true` (mandatory). Every wake records
`ctx.request().id` into `currentInvocationId`; the shared `signal(interrupt)`
handler reads it live and `ctx.cancel`s it; the wake races the harness
`ctx.run` against `ctx.cancellation()` (`raceInterrupt`), whose map callback
aborts an `AbortController` merged with `attemptCompletedSignal`
(`AbortSignal.any`) into the signal every long closure must honor. On
interrupt the handler still commits `control` + `run_finished(interrupted)`
durably and the entity stays immediately messageable. T2.5 builds
`pause`/`resume`/`archive` on the same shared handler (K/V is read-only
there: control = cancel + one-way sends only).

**Wake-input convention.** The handler commits the wake input as canonical
`message` event(s) BEFORE the harness runs and passes
`HarnessRunInput.wakeMessage: null` — context always ends on the wake input.

**Needs a live runtime (T6.3/T9.1):** real cancel delivery +
`explicitCancellation` semantics (`@experimental` in SDK 1.16.2 — pinned),
crashed-`ctx.run` replay, delayed-send timing, per-handler
inactivity/abort timeouts, shared-handler K/V visibility timing.

## Design note — T2.2 projection outbox (`src/projection-outbox.ts`)

`DurableStreamsProjectionOutbox` is the REAL `ProjectionOutbox` — D3
implemented exactly against the durable-streams idempotent producer
(server `electricax/durable-streams-server-rust:0.1.4`; protocol semantics
extracted from its source, `../electric/packages/durable-streams-rust/src/
handlers.rs`, and re-verified live against the image).

**Mapping (addressing §7 / A1 / A9).** `Producer-Id` = entity url,
`Producer-Epoch` = K/V `outboxProducerEpoch`, `Producer-Seq` = canonical seq
− K/V `outboxProducerSeqOffset` (both 0 in normal operation ⇒ the identity;
see the 0002:T2.1 design note below). The server assigns ONE
producer seq per POST (per-batch, not per-record), so flush appends **one
event per POST** — that is the thin mapping that keeps `(entityId, seq)` the
dedup key. The pinned client's `IdempotentProducer` (session-scoped seq,
auto-claim epochs) deliberately is NOT used: it cannot carry a persistent
K/V-backed seq. We import the client (0.2.6, exact-pinned to pair with
server 0.1.4 as upstream does) for header constants and reading.

**Flush = confirm-then-trim.** Pre-flight contiguity checks (no I/O), then
ONE `ctx.run` appends the pending events in order from the first unconfirmed
(404 → PUT-create per C3, once), then trim + `outboxConfirmedSeq` (the
trim-time last-confirmed tracker T5.3 reads), then catalog
`head_seq`/status upsert in a second `ctx.run` (monotonic via `GREATEST`,
`src/projection-catalog.ts`). Duplicates (`seq <= last_seq`) are no-ops —
crash-between-append-and-trim replays cleanly; gap / stale-epoch / closed /
recreated-empty-stream surface as `OutboxDriftError` (terminal — repair
belongs to the reconciler, never to a hot retry loop). `stage` enforces the
A4 ~1 MiB journal budget per event and per pending-outbox value
(`OutboxBudgetError`).

**Gate 3 tests** (`src/projection-outbox.test.ts`): fast-check property
suites drive arbitrary crash/fault schedules (ack-lost after apply, network
failure before apply, `ctx.run` result lost after side effects) against a
faithful fake of `validate_producer` (`src/testing/fake-timeline-server.ts`)
and assert exactly-once + in-order + 0-based-gapless + trimmed-K/V +
catalog-tracking invariants after every recovery. The same protocol edges
are re-verified against the real 0.1.4 image in
`src/projection-outbox.integration.test.ts` (env-gated:
`TEASPILL_T22_REAL_DS_URL`), including a read-back through the pinned
client.

**Known server caveat** (documented in the module header): producer dedup
state persistence is debounced server-side (checkpoint cadence), so a
_server_ crash inside that window can readmit an acked append → a duplicate
record with the same `seq`. Events carry `seq`, so readers dedup
deterministically (T5.2 reducer rule) and T9.1 should chaos-test it.

## Design note — 0002:T2.1 affine epoch reset + reconcile handlers

The 0001:A9 follow-up: the catastrophic-recovery path v1 designed but left
unbuilt (`allowEpochReset: false` until wired). Three pieces, one invariant.

**The affine append.** The producer mapping is generalized from the identity
to `Producer-Seq = canonicalSeq − outboxProducerSeqOffset`, with the offset
persisted in K/V beside `outboxProducerEpoch` (both absent ⇒ 0 ⇒ identity,
A1 byte-identical to v1). Nothing above the outbox ever sees either value:
events carry only their canonical `seq`, and readers/dedup/context stay
canonical-seq based (A6#2) — asserted byte-level in the test suite.

**The reset step** (`handleReconcileRecovery`, the only writer of
epoch/offset): on a drift that in-order replay provably cannot fix — the
handler re-verifies with a live flush inside its own exclusive invocation
before doing anything destructive — it folds the stuck pending events into
the bounded context (their content survives), drops them (they are the
history hole), stages a `state_snapshot(reason: "recovery",
historyHole: true)` at the next canonical seq N, and sets `epoch = max(own,
server)+1`, `offset = N`, `confirmedSeq = N−1`. The snapshot therefore
appends at `Producer-Seq 0` under the new epoch (the server's
new-epoch-starts-at-0 rule) while the canonical seq keeps counting gaplessly
(A1); later events append at `seq − N`. The stale byte-offset seek hint is
cleared (offsets from the lost stream are meaningless); the snapshot's SEQ
still reaches the catalog so fast-join finds the hole boundary (A6#5 floor).
The whole drop→stage→reset block sits between journal boundaries (clock read
first), so no crash window can drop events without also staging the marker —
a window the property suite actually caught during development. The same
invariant holds on the non-crash failure path: `stage()` enforces the
outbox's OWN budgets (`maxEventBytes`/`maxPendingBytes`), independent knobs
from `archiveSnapshotMaxBytes`, so a rejected snapshot restores the pre-drop
K/V and returns `failed` with the pending outbox intact — a budget
misconfiguration can never strand an unmarked hole (regression-tested). A
CLOSED stream is refused outright (`stream-closed`, alert-and-hold): no
epoch can ever append to it, so a reset would only churn — a fresh snapshot
+ epoch bump per reconciler tick, forever; the handler holds the entity
stable and stuck until ops reopen/replace the stream. Epoch/offset
survive archive→resurrection (carried in the archive snapshot; resurrection
previously hard-reset epoch to 0, which would fence a post-reset entity).

**The split (A9, kept exactly).** The reconciler DETECTS drift, ALERTS, and
REQUESTS recovery; the agent object EXECUTES it. Three handlers on
`agent.<type>` (logic in `projection-outbox.ts`, wiring in `agent.ts`):
`reconcileProbe` — SHARED, a handful of K/V gets, no `ctx.run`, no I/O, so it
never blocks behind a busy exclusive wake; `reconcileFlush` — EXCLUSIVE,
re-drives the flush and maps `OutboxDriftError` to a drift outcome;
`reconcileRecovery` — EXCLUSIVE, the reset above, gated by the request's
`resetEpoch` (a `false` request is a pure no-op). The reconciler's
`createRestateEntityReconcileClient` targets exactly these names.

**Gate 1 evidence** (`projection-outbox.test.ts`): the Gate-3-style
fast-check suite extended with catastrophe schedules — arbitrary interleaved
stream loss / producer-state rollback / append faults / crashes at every
journal boundary of the recovery itself — asserting after every settled
step: reader seq-dedup (same-seq records byte-identical, first wins),
in-order, every hole bridged by a `historyHole` snapshot, exactly-once
content per visible seq, canonical allocation 0-based gapless, K/V settled,
and server producer state == (K/V epoch, head − offset). Plus a
deterministic crash-point sweep and an end-to-end
reconciler→handlers→healed-stream test over the real logic. With that
green, `DEFAULT_RECONCILER_SPEC.allowEpochReset` flipped to `true`; the
destructive step remains evidence-gated at execution time by the re-verify
flush. Live provocation of this path is 0002:T4.3 (chaos).

## Cron (T2.4)

See the header of `src/cron.ts` (generation-guarded self-rescheduling,
croner for tz/DST).

## Endpoint

`createCoordinationEndpoint({ agents })` binds cron + any agent objects onto
one Restate endpoint for the agent-loop service to serve.
