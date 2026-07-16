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

## Amendments log
(none yet)
