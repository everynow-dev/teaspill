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

### A4 — Restate cancellation & step-durability constraints (from T2.0, binds T2.1/T2.5/T3.2/T4.1)
Code-verified against Restate server 1.7.2 + TS SDK 1.16.2 (see `SPIKE-RESTATE.md`). (1) Agent and workspace virtual objects MUST set `explicitCancellation: true` — under default cancellation, post-cancel awaits rethrow and the T2.5 contract ("interrupt leaves state consistent") is unimplementable. Interrupt = shared handler `ctx.cancel(currentInvocationId read from K/V)` + in-handler `ctx.cancellation()` race + AbortController (~20 ms abort latency, code-verified). The cancellation API is `@experimental` in SDK 1.16 → **pin the SDK version and conformance-test this seam** (feeds T6.3/T9.1). (2) Journal entries budget ≤ ~1 MiB in code; `ctx.run` results are fine to 16 MiB but ≥32 MiB *wedges* the invocation at replay after committing; ingress payload cap is 32 MiB (413 above). Bulk → streams, journal carries refs (R4). (3) Long `ctx.run` bodies are at-least-once and aborted attempts overlap retries concurrently: per-handler `inactivityTimeout`/`abortTimeout` must exceed worst-case step latency, and every long closure must abort on `AbortSignal.any([interruptSignal, ctx.request().attemptCompletedSignal])`. (4) Restate idempotency expiry is LAZY — treat retention (default 24h, tunable) as a floor, never design around expiry. (5) A3 confirmed: `agent.<type>` service names accepted; keys are arbitrary strings incl. url/slash (percent-encode in ingress paths; gateway must reject empty key).

### Tooling note (from T0.3, non-blocking)
Pin `typescript < 6.1.0` until `typescript-eslint` ships a 7.x-compatible release (`typescript-eslint@8.64` caps TS peer at `<6.1.0`). A future TS bump must re-check.
