# @teaspill/coordination

Restate coordination services (Phase 2): the agent virtual object template
(T2.1), cron (T2.4), and — landing via their own tasks — the projection
outbox (T2.2), messaging/pub-sub (T2.3), control API (T2.5), steerbox (T2.6).

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

## Cron (T2.4)

See the header of `src/cron.ts` (generation-guarded self-rescheduling,
croner for tz/DST).

## Endpoint

`createCoordinationEndpoint({ agents })` binds cron + any agent objects onto
one Restate endpoint for the agent-loop service to serve.
