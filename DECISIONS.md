# teaspill — Decisions ledger

Seeded from PLAN.md §2. Amendments appended over time (newest at bottom of each section or in the Amendments log). If a task's findings contradict a decision here, the subagent proposes an amendment and halts its thread until resolved.

name: teaspill

---

## D1 — Sources of truth (one owner per concern)
- **Restate K/V (per agent virtual object):** live entity state — status, bounded conversation context, `seq` counter, projection outbox, workspaceRef, subscriber list. The only store consulted for control flow.
- **Postgres (catalog):** entity registry rows (url, type, status, tags, parent, `head_seq`, latest snapshot offset, archived snapshot JSONB). Written only from inside agent handlers via `ctx.run`. Synced to UIs via Electric shapes. Also the archive-of-record for archived entities.
- **Durable streams:** authoritative *history/telemetry* — per-agent timeline events and token deltas. Append-only, browser-readable, resumable, HTTP-cacheable. **Never read to decide what to do.** Regenerable going forward (snapshot + continue), not backward.

## D2 — Coordination = Restate primitives
- Agent = virtual object `agent/<type>` keyed by instance id. One "wake" = one invocation. Single-writer per key.
- Spawn = one-way durable send carrying the parent's key; completion = child sends `childFinished` to parent. No wake registry.
- Delayed sends replace the scheduler; cron = a tiny self-rescheduling object.
- Observe-on-change = explicit pub/sub: observed entity keeps a subscriber list in its K/V and notifies; debounce = delayed send + dedupe flag.
- Steering: a `steer/<entityId>` companion object buffers messages sent while a run is in flight; harnesses drain it at step/tool boundaries and inject into the live run. Idle entity → steer degrades to a normal message wake.
- Control is a minimal verb API — `interrupt(reason?)`, `pause`, `resume`, `archive` — not POSIX signals. Custom control needs are typed messages.
- All nondeterminism (LLM calls, HTTP, clock) inside `ctx.run`. Journal entries stay bounded (results are summaries/refs; bulk data goes to streams).

## D3 — Exactly-once projection (the outbox protocol)
- Per-entity monotonic `seq`, incremented in-handler (committed atomically with state under single-writer).
- Events buffered in a K/V pending-outbox; appended to the stream via the durable-streams idempotent producer keyed `(entityId, seq)`; trimmed only after confirmed append; retried from outbox on next invocation.
- Catalog `head_seq` updated alongside. Drift detection: client-side seq-gap check + periodic reconciler comparing catalog `head_seq` vs stream tail. Catastrophic stream loss: write state-snapshot event, mark history hole, continue.

## D4 — Two service planes, independently scalable
- **Agent-loop services:** stateless replicas registered with Restate; run harnesses; scale on LLM concurrency.
- **Executor fleet:** `workspace/<key>` virtual objects fronting real environments (Docker first; local-unrestricted for dev; remote later). Serialized access per workspace by construction. Long execs complete via awakeables; stdout streams out-of-band. `workspaceRef` lives in agent state; **no mid-session switching**.

## D5 — Harness abstraction
`Harness.run({ canonicalContext, wakeMessage, tools, steerSource, signal, emitDelta }) → { events[], stateDelta, usage }`. Two implementations:
- **pi-ai harness** (we own the loop; multi-provider): fully step-durable. Every LLM call is its own `ctx.run`; every tool call is a real journaled Restate invocation; canonical events commit through the outbox at each step boundary; steerbox drained between steps. Gold standard for durability; recommended default.
- **CASDK harness** (SDK owns the loop): Claude Code semantics reproduced via three durability layers — Effects (idempotency key `(entityUrl, runId, toolUseId)`), Continuation (durable session as intra-run journal), Truth (canonical timeline authority, trust-but-verify via seq stamp; warm resume vs cold rebuild).
- CASDK surface: no built-in tools, permissions bypassed, no built-in subagents; hooks as observers only; platform + workspace tools via in-process MCP server; steering via streaming-input injection; `interrupt` verb → SDK interrupt.
- Delta/resume consistency (both): finalized events land on stream as they complete; resume works off state containing everything finalized — memory always a superset of what user saw, minus at most a trailing partial message.

## D6 — Deployment & auth
- Self-host compose: **restate, postgres, electric, durable-streams (Rust binary), gateway**. Agent-loop services and executors are developer-deployed and register through the gateway. Internal services not exposed; gateway is single entrypoint.
- Auth: API keys at the gateway for all server-side access. No permissions/scoping model at platform layer — developer proxies and implements authz. Optional fast-follow: gateway-verified short-lived HS256 JWTs (shared secret) with a single path-prefix claim for browsers to read streams/shapes directly. Writes never bypass the developer.

## D7 — Entity lifecycle
active → idle → archived. Archive (self-scheduled after idle window): write compact snapshot to catalog row + terminal stream event, clear K/V. Resurrection on new message: rehydrate from the Postgres snapshot (not the stream). Restate holds the working set only; it is not the archive.

## D8 — Explicitly dropped from electric agents scope
Wake registry & conditional collection-change wakes; pgSync bridge; tag streams + outbox drainer; entity projector; dual webhook/pull-wake delivery; the stream-as-entity-truth materialization + compaction protocol (keep only simple snapshot events); desktop/mobile apps; built-in Horton/Worker agents; platform-level principals/permissions; multi-tenancy (single-tenant per deployment); MCP *bridge* package (still *serve* MCP tools to CASDK in-process); mid-session executor switching; the POSIX signal vocabulary — replaced by the minimal control API in T2.5 (`interrupt`, `pause`/`resume`, `archive`), with custom control payloads as typed messages.

---

## License verification (T0.4)

Verified 2026-07-17 via live fetch of primary sources (not training data).

### 1. Restate server
- **License:** Business Source License 1.1 (BSL 1.1) — source-available. **Change Date:** 4 years after each release (rolling per-version). **Change License:** Apache-2.0.
- **Source:** https://github.com/restatedev/restate/blob/main/LICENSE
- **Additional Use Grant:** permits self-host/internal/commercial use; prohibits only operating a "Public Restate Platform Service" (a multi-tenant managed service letting third parties register their own Restate service endpoints and invoke through it).
- **Verdict: OK, conditional on architecture.** Teaspill's D6 (gateway single entrypoint, Restate never exposed directly) + D8 (single-tenant per deployment) fit the permitted bucket. **Standing constraint:** if teaspill ever becomes a multi-tenant hosted SaaS exposing raw Restate registration to third-party devs, re-review.

### 2. durable-streams client libs + Rust server
- **Client libs / reference Node server** (`durable-streams/durable-streams`, TS): **MIT** (PLAN guessed Apache-2.0 — corrected; MIT is ⊇-permissive, not a blocker). Source: https://github.com/durable-streams/durable-streams
- **Rust server** (`@electric-ax/durable-streams-server-rust`, lives in `electric-sql/electric` monorepo): **Apache-2.0**. Source: https://github.com/electric-sql/electric/blob/main/LICENSE
- **Verdict: OK.** Both fully permissive. Note precise per-component license for any future NOTICE/attribution file.

### 3. Restate TypeScript SDK
- **License: MIT** (as expected). Source: https://github.com/restatedev/sdk-typescript. **Verdict: OK.**

### Overall R1 verdict: **PROCEED** — no license blocks commercial self-hosting as designed. DBOS/Temporal fallback not needed.

---

## Amendments log

### A1 — Canonical `seq` is 0-based and gapless per entity (from T0.2, binds T0.1)
The durable-streams idempotent producer (constraint C4, read from `../electric` durable-streams-rust source `handlers.rs:850`) requires each producer's sequence to **start at 0 and increase by exactly 1 with no gaps**. Mapping the outbox (D3) as `Producer-Id = entity url`, `Seq = canonical seq` therefore forces the canonical per-entity `seq` to be **0-based and gapless**. **T0.1 must bake this in** (a `state_snapshot` at seq N still occupies a seq slot; nothing may skip). This is not a contradiction of D1–D3 — it makes D3's `(entityId, seq)` producer key concrete.

### A2 — `entities.tenant` column + normalized `entity_tags` (from T0.2, recommendation to T1.3)
Addressing reserves a tenant prefix segment (`/t/<tenant>/...`), single default tenant for now (consistent with D8 "a tenant is a deployment" — naming reservation, not runtime multi-tenancy; Restate keys carry no tenant). T1.3 should add an `entities.tenant` column and keep tag filtering on a normalized `entity_tags(url, tag)` table (Electric `where` over `tags jsonb` is awkward/unparameterizable — confirmed against Electric typescript-client `types.ts:93`). Non-blocking extension, not a contradiction.

### A3 — Restate service naming to confirm in T2.0 (from T0.2)
Addressing proposes Restate service name `agent.<type>` keyed by `<id>`; `steer` keyed by full entity url; `workspace` keyed by `<tenant>/<name>`; `cron` keyed by `<name>`. T2.0 spike must confirm Restate accepts a `.`-containing service name and url-as-key.

### A10 — Resurrection lands; idle auto-archive safe-ON; onWake contract (from T8.1, refines A8 + the dead-letter Note)
Resurrection is BUILT, so A8's "keep idle auto-archive off until T8.1" caution is LIFTED. A message/spawn to an archived entity rehydrates from the catalog `archived_snapshot` (D1/D7 — never the stream), INSIDE the message/spawn handler (single-writer race-safe: first invocation rehydrates, second sees live state), continuing seq from `head_seq` (A5: `archived` is episode-terminal, epoch stays 0). Idle auto-archive is now DEFAULT-ON (`idleArchiveDelayMs` default 30 min, `0` disables, epoch-reset on activity). The dead-letter Note is RESOLVED: `DEFAULT_DEAD_STATUSES` flipped to `[]` (archived delivers→resurrects; only null/invalid targets dead-letter; overridable to `["archived"]` to opt out). Archive persistence: `archived_snapshot` JSONB written via a `@teaspill/catalog` `ArchiveCatalog` seam (`createDrizzleArchiveCatalog`), SIZE-BOUNDED at write time (256 KiB default; bounded context not timeline; drops oldest context events, `ArchiveSnapshotTooLargeError` only if non-context state overflows). Byte-offset: NEW catalog column `snapshot_stream_offset` (opaque durable-streams offset, text; migration `0002`) beside `snapshot_offset` (seq) so T5.2 fast-join seeks to the snapshot record without scanning from 0; captured best-effort in the outbox flush (early-not-late so reader correctness holds via the A6#5 seq floor). **onWake CONTRACT** (T6.1 carry-forward, now loop-wired in `runWake`): a `defineAgent` `onWake` runs deterministically inside the wake (emit/send/spawn/now, journaled), then either HANDLES the wake fully (onWake-only ⇒ NO LLM — deterministic conformance agents, T6.3) or HANDS OFF to the static harness (onWake events precede harness output). agents-sdk wired this through in T7.2 (widened `OnWakeHandler`, `compileConfig` forwards `onWake` + `archiveCatalog`). Non-contradictory.

### A9 — A6#6 resolved: reconciler epoch/offset stance (from T5.3)
The T5.3 reconciler's AUTOMATIC repairs never bump the durable-streams producer epoch: `catalog_lag` is a pure catalog GREATEST re-upsert; `stuck_outbox` is in-order flush REPLAY at the existing epoch (T2.2). So `Producer-Seq == seq` (A1) holds and **A6#6 is a documented NON-ISSUE for the common repair paths**. The catastrophic reset (writing `state_snapshot(recovery, historyHole:true)` onto a genuinely-lost/fenced/closed stream where replay can't proceed) is the only epoch-bumping path; its identity is preserved by generalizing to the AFFINE map `Producer-Seq = canonicalSeq − outboxProducerSeqOffset`, persisting `outboxProducerSeqOffset` in the entity K/V beside `outboxProducerEpoch`. Normal op = offset 0/epoch 0 ⇒ Producer-Seq==seq (A1 unchanged). Reset at canonical seq N: epoch E+1, offset N ⇒ recovery snapshot appends at Producer-Seq 0 under the new epoch (satisfies "new epoch starts at 0") while canonical seq stays N (gapless, A1); later events append at seq−N. Readers/dedup/context are canonical-seq based (A6#2) → epoch+offset invisible above the outbox. **v1 SCOPE:** the affine append + reset step belong in `projection-outbox.ts` + the agent object (NOT owned by T5.3); the reconciler DETECTS the unrecoverable condition, ALERTS (an `AlertSink` seam T8.2 wires), and REQUESTS recovery via an agent-object seam. The destructive reset is GATED by `ReconcilerSpec.allowEpochReset` (default false, like A8's idle-auto-archive caution) until main wires the offset-aware append. Non-blocking; supersedes A6#6's "Open for T5.3". **Follow-up for a later group:** add agent-object handlers `reconcileProbe`(shared)/`reconcileFlush`/`reconcileRecovery`(exclusive) + the affine-offset append in `projection-outbox.ts` to make `createRestateEntityReconcileClient` live.

### A8 — Control verbs seam split + idle-auto-archive sequencing (from T2.5, refines A4/D8)
`interrupt` is the only verb reaching a busy wake → SHARED handler (`ctx.cancel(currentInvocationId)` + `raceInterrupt`, ~20ms abort). `pause`/`resume`/`archive` write K/V → EXCLUSIVE (serialize behind the in-flight wake, take effect at next invocation start). Because a shared handler can't write K/V (SPIKE §a), the interrupt free-text `reason` can't be attached to the busy run's `control(interrupt)` event by the interrupter — it's returned to the caller; the event records verb only (T7.2 CASDK interrupt inherits this). `pause` = runtime K/V flag `AGENT_KV.paused` + `pausedMailbox`, orthogonal to the frozen `entities.status` enum (paused entity queues messages, `resume` re-enqueues in order). `archive` implemented minimal-correct in coordination (flush → status=archived → control(archive) + state_snapshot(pre_archive) + terminal `archived` + clear K/V) and now ALSO fires from the idle `archiveTick` (was a stub). **⚠ SEQUENCING for T8.1:** resurrection + the dead-status flip (DECISIONS "Note — dead-letter vs resurrection") are NOT built → an idle entity that auto-archives will DEAD-LETTER subsequent messages until T8.1 lands. Mitigation until G12/T8.1: **idle auto-archive should stay opt-in/disabled by default** (or the archiveTick not scheduled) so no entity strands; the `archive` verb (explicit) is safe. Catalog `archived_snapshot` JSONB persistence deferred to T8.1 (needs a `@teaspill/catalog` writer seam; the snapshot STATE is already on the stream).

### A7 — Stream retention reality + snapshot cadence (from T5.1, binds T8.1/T8.2/T5.2/T5.3)
Verified against `../electric` durable-streams-rust HEAD (= :0.1.4 source). **No per-stream prefix truncation exists** (can't drop `seq < N` and keep appending); `--tier`/`tier.rs` compaction is transparent cold-offload (logical length only grows, data stays readable at same offsets). What EXISTS = whole-stream lifecycle only: `Stream-TTL` (sliding, reset on access) / `Stream-Expires-At` (mutually exclusive), `DELETE` soft-delete→410, close; `--tier s3` for bounded local disk with full logical history. **Retention stance v1:** timeline stream is NEVER TTL'd (authoritative, D1; T8.1 archive owns its end-of-life per entity); ephemeral streams (`/deltas`, workspace/exec stdout) get `Stream-TTL` at create (proposed 6h deltas / 24h stdout — tune later). Per-entity growth is bounded by the archive lifecycle (T8.1), total disk monitored in T8.2 (matches PLAN T5.1 anticipate — "don't build truncation the server lacks"). **Snapshot cadence** (`packages/schema/src/snapshot-policy.ts`, pure): the AGENT OBJECT emits `state_snapshot` at outbox time (seq allocator, A1 — never a harness); triggers `periodic` (≥200 seq OR ≥256 KiB since last), `pre_archive` (forced, D7), `recovery` (forced, D3). Catalog `snapshot_offset` = latest snapshot's seq (GREATEST-monotonic upsert alongside head_seq); fast-join loads snapshot@N then consumes N+1 (A5 inclusive). Spec in `docs/streams.md`.

### Note — dead-letter vs resurrection (from T2.3, action for T8.1)
T2.3's dead-letter treats a send to an `archived` entity as undeliverable (`DEFAULT_DEAD_STATUSES=["archived"]`) → error on sender's timeline. This is correct TODAY (archived K/V is cleared, its `message` handler throws). But D7/T8.1 says a message to an archived entity **resurrects** it. Resolution: the dead-status set is overridable (`deadStatuses` config). **T8.1 must flip the default so `archived` is NOT dead** once the resurrection path (rehydrate-from-catalog-snapshot inside the message handler) lands. Not a contradiction now; a required follow-up.

### A6 — durable-streams producer reality (from T2.2, binds T5.2/T5.3/T9.1)
Extracted from the rust server source (`handlers.rs` validate_producer/handle_append_inner; no PROTOCOL.md in checkout), verified against the real `:0.1.4` image. Client `@durable-streams/client` pinned **0.2.6** (pairs with the 0.1.4 server source). Findings that bind downstream: (1) **Producer-Seq is per-REQUEST, not per-record** — so the outbox does one raw POST per canonical event with `Producer-Seq = seq` (the "thin mapping" PLAN T2.2 anticipated); the client's `IdempotentProducer` convenience class is session-scoped and unused for appends (headers + read-back only). (2) Server producer-dedup state persists **DEBOUNCED** (checkpoint cadence) → a SERVER crash can readmit an already-acked append as a same-seq duplicate stream record → **readers MUST dedup by embedded canonical `seq`** (T5.2 reducer rule already says "finalized event wins"; T9.1 chaos-tests this window). (3) Append verdicts: same epoch seq≤last ⇒ 204 no-op, last+1 ⇒ 200, gap ⇒ 409 + Producer-Expected-Seq (out-of-order after gap REJECTED → outbox replays in order from first unconfirmed); lower epoch ⇒ 403 fenced. (4) Outbox tracks `outboxConfirmedSeq` in K/V at trim time (cheap last-confirmed for T5.3, avoids stream tail scan). (5) **Catalog `head_seq` is a FLOOR**, not exact, under a crash between stream-trim and catalog-upsert (monotonic GREATEST upsert; T5.3 reconciles). (6) **Open for T5.3:** an epoch-bump/reset path would break `Producer-Seq == seq` identity → needs a per-producer offset when that recovery path is built. Gate 3 GREEN.

### A5 — Canonical event schema FROZEN v1 (Gate 1 passed at G3, 2026-07-17)
Main session reviewed `docs/casdk-mapping.md` (CASDK round-trip + pi-ai sketch) against `packages/schema/src/{events,deltas}.ts` and froze the schema. Round-trip is lossless: warm path never projects (durable session is continuation state); cold path derives the 4 SESSION_FORMAT line shapes from `message`/`tool_call`/`tool_result`/`summarization`; unknowns become `opaque`; the only non-round-tripped content is thinking signatures (a security feature — unforgeable) and enumerated operational chatter. The four freeze-review items ALL ACCEPTED: (1) event type is `control` not PLAN's `signal` (per D8 dropped-POSIX vocab); (2) `summarization.payload.detail` added (informational, never affects the fold); (3) `ContentBlock` = text+image only for v1 (attachments out of scope T1.2c; future `document` blocks ride `opaque`; richer tool output goes in `tool_result.detail` JSON); (4) `tool_result.detail` is populated by the in-process tool layer, not stream capture (→ note for T7.2). **Freeze rule going forward:** additive-only within v1; breaking change ⇒ bump `v` + migration. Downstream (both harnesses, outbox T2.2, frontend T5.2, archive T8.1) may now build against v1 as stable.

### A4 — Restate cancellation & step-durability constraints (from T2.0, binds T2.1/T2.5/T3.2/T4.1)
Code-verified against Restate server 1.7.2 + TS SDK 1.16.2 (see `SPIKE-RESTATE.md`). (1) Agent and workspace virtual objects MUST set `explicitCancellation: true` — under default cancellation, post-cancel awaits rethrow and the T2.5 contract ("interrupt leaves state consistent") is unimplementable. Interrupt = shared handler `ctx.cancel(currentInvocationId read from K/V)` + in-handler `ctx.cancellation()` race + AbortController (~20 ms abort latency, code-verified). The cancellation API is `@experimental` in SDK 1.16 → **pin the SDK version and conformance-test this seam** (feeds T6.3/T9.1). (2) Journal entries budget ≤ ~1 MiB in code; `ctx.run` results are fine to 16 MiB but ≥32 MiB *wedges* the invocation at replay after committing; ingress payload cap is 32 MiB (413 above). Bulk → streams, journal carries refs (R4). (3) Long `ctx.run` bodies are at-least-once and aborted attempts overlap retries concurrently: per-handler `inactivityTimeout`/`abortTimeout` must exceed worst-case step latency, and every long closure must abort on `AbortSignal.any([interruptSignal, ctx.request().attemptCompletedSignal])`. (4) Restate idempotency expiry is LAZY — treat retention (default 24h, tunable) as a floor, never design around expiry. (5) A3 confirmed: `agent.<type>` service names accepted; keys are arbitrary strings incl. url/slash (percent-encode in ingress paths; gateway must reject empty key).

### Tooling note (from T0.3, non-blocking)
Pin `typescript < 6.1.0` until `typescript-eslint` ships a 7.x-compatible release (`typescript-eslint@8.64` caps TS peer at `<6.1.0`). A future TS bump must re-check.
