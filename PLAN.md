# teaspill — Implementation Plan

Project name: **teaspill** (decided). This document is self-contained: it carries the architectural context, the decisions already made, the full task breakdown with anticipation notes, a model-size rating per task, and the orchestration protocol (§8) for executing it with a main coordinating session dispatching subagents.

---

## 1. Background and motivation

This platform is a from-scratch rebuild of what ElectricSQL's "electric agents" (electric.ax) promises — durable agents that run, spawn sub-agents, communicate, share context, and stream their activity to UIs — but with a radically simpler coordination model.

Why not build on electric agents: its architecture keeps the same state in multiple stores (durable streams as event-sourced entity truth, Postgres tables, Electric shapes, in-memory caches) with hand-rolled replication between them ("bridges", projectors, outbox drainers, a wake registry synced from Postgres via Electric shapes into an in-memory cache). Every replication edge is a bespoke consistency problem. Observed consequences (bugs found and fixed upstream by us): dropped parent wakes on parallel sub-agent spawn (dual-path wake registration + stale cache rebuild), lost `message_type` in timeline materialization, undocumented Docker webhook loopback rewriting. The platform is also simultaneously a framework, a cloud service, a desktop/mobile app, and a product — we want a lean subset.

**What we keep from the electric agents vision:** durable entities with a wake model; spawn/send/observe between agents; per-agent timelines streamable to browsers over resumable, cacheable HTTP; realtime UI sync.

**What we change:** all coordination moves to Restate (virtual actor model + durable execution); durable streams and Postgres+Electric are demoted to write-only projections; the agent loop and the tool-execution environment become two independently scalable services; harnesses (native Anthropic API loop, Claude Agent SDK) are pluggable behind one interface.

## 2. Core architectural decisions (already made)

These are settled. Tasks below implement them; if a task uncovers evidence against one, stop and escalate rather than silently deviating.

### D1 — Sources of truth (one owner per concern)
- **Restate K/V (per agent virtual object):** live entity state — status, bounded conversation context, `seq` counter, projection outbox, workspaceRef, subscriber list. The only store consulted for control flow.
- **Postgres (catalog):** entity registry rows (url, type, status, tags, parent, `head_seq`, latest snapshot offset, archived snapshot JSONB). Written only from inside agent handlers via `ctx.run`. Synced to UIs via Electric shapes. Also the archive-of-record for archived entities.
- **Durable streams:** authoritative *history/telemetry* — per-agent timeline events and token deltas. Append-only, browser-readable, resumable, HTTP-cacheable. **Never read to decide what to do.** Regenerable going forward (snapshot + continue), not backward.

### D2 — Coordination = Restate primitives
- Agent = virtual object `agent/<type>` keyed by instance id. One "wake" = one invocation. Single-writer per key.
- Spawn = one-way durable send carrying the parent's key; completion = child sends `childFinished` to parent. No wake registry.
- Delayed sends replace the scheduler; cron = a tiny self-rescheduling object.
- Observe-on-change = explicit pub/sub: observed entity keeps a subscriber list in its K/V and notifies; debounce = delayed send + dedupe flag.
- Steering: a `steer/<entityId>` companion object buffers messages sent while a run is in flight; harnesses drain it at step/tool boundaries and inject into the live run. If the entity is idle, a steer degrades to a normal message wake. No run needs to finish before the agent can read new input.
- Control is a minimal verb API — `interrupt(reason?)`, `pause`, `resume`, `archive` — not POSIX signals (see D8/T2.5). Custom control needs are just typed messages.
- All nondeterminism (LLM calls, HTTP, clock) inside `ctx.run`. Journal entries stay bounded (results are summaries/refs; bulk data goes to streams).

### D3 — Exactly-once projection (the outbox protocol)
- Per-entity monotonic `seq`, incremented in-handler (committed atomically with state under single-writer).
- Events buffered in a K/V pending-outbox; appended to the stream via the durable-streams idempotent producer keyed `(entityId, seq)`; trimmed only after confirmed append; retried from outbox on next invocation.
- Catalog `head_seq` updated alongside. Drift detection: client-side seq-gap check + periodic reconciler comparing catalog `head_seq` vs stream tail. Catastrophic stream loss: write state-snapshot event, mark history hole, continue.

### D4 — Two service planes, independently scalable
- **Agent-loop services:** stateless replicas registered with Restate; run harnesses; scale on LLM concurrency.
- **Executor fleet:** `workspace/<key>` virtual objects fronting real environments (Docker first; local-unrestricted for dev; remote later). Serialized access per workspace by construction. Long execs complete via awakeables; stdout streams out-of-band. `workspaceRef` lives in agent state; **no mid-session switching** (dropped requirement — a workspace is chosen at spawn/config time and kept).

### D5 — Harness abstraction
`Harness.run({ canonicalContext, wakeMessage, tools, steerSource, signal, emitDelta }) → { events[], stateDelta, usage }`. Two implementations:

- **pi-ai harness** (we own the loop; multi-provider): fully step-durable. Every LLM call is its own `ctx.run`; every tool call is a real journaled Restate invocation; canonical events commit through the outbox at each step boundary; the steerbox is drained between steps. This is the gold standard for durability and the recommended default for custom agents.
- **CASDK harness** (the SDK owns the loop): Claude Code semantics faithfully reproduced, via three durability layers:
  1. *Effects:* every tool handler invokes workspace/platform objects through Restate ingress with idempotency key `(entityUrl, runId, toolUseId)` — exactly-once side effects even under whole-run retry.
  2. *Continuation:* the CASDK durable session (SessionStore / session files on persistent storage keyed by entity) is the intra-run journal — the same mechanism Claude Code's own interrupt-and-continue uses. A retried `ctx.run` resumes the session and continues from the last persisted step instead of restarting the run.
  3. *Truth:* the canonical timeline remains authority, with **trust-but-verify**: the session carries a stamp of the last canonical `seq` it reflects. Stamp == canonical head → warm resume. Mismatch or lost session → cold rebuild by projecting from canonical. Projection is the recovery path, not the every-wake hot path.

  CASDK surface: no built-in tools, permissions bypassed, no built-in subagents; hooks used as **observers only** (PostToolUse + partial-message events feed finalized events and token deltas to the stream live); platform + workspace tools via in-process MCP server; steering via streaming-input injection; the `interrupt` verb maps to the SDK's interrupt.

Delta/resume consistency (both harnesses): finalized events land on the stream as they complete, and resume works off state that contains everything finalized — so the agent's memory is always a superset of what the user saw, minus at most a trailing partial message (the same loss as interrupting Claude Code mid-generation).

### D6 — Deployment & auth
- Self-host compose: **restate, postgres, electric, durable-streams (Rust binary), gateway**. Agent-loop services and executors are developer-deployed and register through the gateway. Internal services are not exposed; the gateway is the single entrypoint.
- Auth: API keys at the gateway for all server-side access. No permissions/scoping model at the platform layer — the developer proxies and implements authz. Optional fast-follow: gateway-verified short-lived HS256 JWTs (shared secret) with a single path-prefix claim, allowing browsers to read streams/shapes directly (preserves caching/resumability for the chattiest traffic). Writes never bypass the developer.

### D7 — Entity lifecycle
active → idle → archived. Archive (self-scheduled after idle window): write compact snapshot to catalog row + terminal stream event, clear K/V. Resurrection on new message: rehydrate from the Postgres snapshot (not the stream). Restate holds the working set only; it is not the archive.

### D8 — Explicitly dropped from electric agents scope
Wake registry & conditional collection-change wakes; pgSync bridge; tag streams + outbox drainer; entity projector; dual webhook/pull-wake delivery; the stream-as-entity-truth materialization + compaction protocol (we keep only simple snapshot events); desktop/mobile apps; built-in Horton/Worker agents; platform-level principals/permissions; multi-tenancy (single-tenant per deployment; a tenant is a deployment); MCP *bridge* package (we still *serve* MCP tools to CASDK in-process); mid-session executor switching; the POSIX signal vocabulary (`SIGINT/SIGSTOP/SIGCONT/SIGHUP/SIGTERM/SIGUSR/SIGKILL`) — agents are not processes; replaced by the minimal control API in T2.5 (`interrupt`, `pause`/`resume`, `archive`), with custom control payloads expressed as typed messages.

## 3. Deliverables

1. **Platform** — the compose stack + gateway + Restate service definitions for coordination (`agent/*` infra layer, `workspace/*`, cron, reconciler).
2. **Agents SDK** — `defineAgent` for developers to write and deploy agents into the platform (typed state, spawn/send/observe, harness selection).
3. **Frontend SDK** — canonical event schema types, stream→collections materialization, catalog shape hooks, actions client. (Our own frontend comes later, on top of this SDK.)

## 4. Cross-cutting risks (watch throughout)

- **R1 Restate maturity/license.** Single-binary self-hosting is easy; verify current server license terms for commercial use (SDKs are MIT; the server has had source-available licensing historically). If unacceptable → fallback candidates: DBOS (Postgres-native) or Temporal (heavy). The harness/executor/projection layers are designed to be portable; only Phase 2 is Restate-shaped.
- **R2 Canonical schema lock-in.** Everything (both harnesses, frontend SDK, snapshots) depends on it. It is validated against *both* harnesses before freezing (T0.1 gate).
- **R3 CASDK format churn.** Pinned version + golden round-trip fixtures in CI; a break costs a projection update, never data — and since projection is the cold/recovery path only (D5), churn cannot disrupt normal warm operation.
- **R4 Journal/payload size limits.** Restate journals and invocation payloads must stay bounded — bulk content (stdout, deltas, large tool results) always goes to streams; journal carries refs.
- **R5 Streaming through the gateway.** Proxying must preserve long-poll/caching semantics of durable streams; test resumability *through* the proxy early (T1.2), not at the end.

---

## 5. Task breakdown

Legend — **Model size**: S = mechanical/boilerplate, well-specified, low blast radius. M = standard implementation requiring local judgment. L = design-heavy, cross-cutting, high blast radius, requires connecting dots across the system. **Critical** = failure blocks or corrupts other phases.

### Phase 0 — Spine: decisions made concrete

**T0.1 — Canonical timeline event schema** · **L** · critical
Design the versioned event envelope `{ v, entityId, seq, ts, type, payload }` and the event vocabulary: `entity_spawned`, `run_started`, `message` (roles: user/assistant/system-note), `tool_call`, `tool_result`, `reasoning` (optional), `state_snapshot`, `summarization` (context truncation boundary), `signal`, `error`, `run_finished`, `child_spawned`, `child_finished`, `archived`. Token deltas are *sub-events* referencing a message id and are excluded from `seq` (they are ephemeral, best-effort, may be dropped by compaction) — decide their framing here.
*Anticipate:* the CASDK mapping (T7.1) will pressure this schema — e.g. CASDK emits event shapes with no native equivalent (its own result/summary records, unknown future types). Provide an `opaque` event type carrying tagged foreign payloads so unknowns round-trip losslessly instead of being dropped. **Gate: do not freeze until a paper mapping exists for both harnesses (do T3.1 and a T7.1 sketch against it first).** Also decide now how snapshots interact with seq (a snapshot event has a seq and asserts "state as of seq N") — the frontend fast-join (T5.2) and archive (T8.1) both depend on this.

**T0.2 — Entity addressing & naming model** · **M**
URL scheme (`/a/<type>/<id>`), instance-id rules, stream path derivation (`/agents/<type>/<id>/timeline`), workspace key derivation, Restate key mapping. Reserve a prefix segment for future multi-tenancy even though we're single-tenant (cheap now, painful later).
*Anticipate:* durable-streams path constraints and Electric shape `where`-clause ergonomics may constrain the scheme — check both before finalizing.

**T0.3 — Repo scaffold** · **S**
pnpm workspace: `packages/{schema,gateway,coordination,agents-sdk,frontend-sdk,harness-native,harness-casdk,executor,cli}`, shared tsconfig, vitest, changesets, CI (lint/typecheck/test).

**T0.4 — License verification** · **S** · gate
Name is decided: **teaspill** (use it for the pnpm scope, packages, and CLI binary). Remaining work: record the R1 license verification result for the Restate server and the durable-streams client libs (Apache-2.0 upstream — confirm) in `DECISIONS.md`.

### Phase 1 — Platform runtime skeleton

**T1.1 — Compose stack** · **S**
`docker-compose.yml`: restate, postgres (logical replication enabled: `wal_level=logical`), electric (pointed at postgres), durable-streams Rust server (volume for data dir), gateway. Healthchecks, sane restart policies, an `.env.example`. A `make dev` / `platform dev` entry.
*Anticipate:* Electric needs specific Postgres config and a publication; the durable-streams image tag should be pinned. If the Rust server image lags features vs the client lib version, pin the client to match the server, not vice versa.

**T1.2 — Gateway service** · **L** · critical
Single entrypoint. Routes: `/api/*` → command endpoints (spawn/send/signal → Restate ingress), `/streams/*` → durable-streams proxy, `/shapes/*` → Electric proxy, `/registry/*` → agent-loop/executor service registration (forwards deployment registration to Restate admin API). Middleware: API-key auth (keys in Postgres, hashed), structured request logging, OTel spans.
*Anticipate:* **(a)** proxying durable streams must pass through long-poll semantics, `ETag`/cache headers, and byte-range/offset params untouched — write an integration test that kills and resumes a client read *through* the gateway on day one (R5). **(b)** Restate admin API for deployment registration may want to reach the agent-loop service directly for discovery — the gateway must either be on the same network or registration goes gateway→restate with the service URL as-is; document the networking assumption (this is the same class of problem as electric's Docker loopback rewrite — solve it explicitly, in docs and in the CLI defaults, not implicitly). **(c)** Body size limits: attachments are out of scope v1; reject >1MB payloads with a clear error.

**T1.3 — Catalog schema + migrations** · **S**
Tables: `entities(url pk, type, status, tags jsonb, parent, head_seq, snapshot_offset, archived_snapshot jsonb, created_at, updated_at)`, `api_keys(id, hash, label, created_at, revoked_at)`. Electric publication over `entities`. Migration tooling (drizzle or raw SQL — pick one, stay boring).
*Anticipate:* Electric shape performance over `tags jsonb` filtering — if `where` on jsonb is awkward, add a normalized `entity_tags(url, tag)` table now rather than a bridge later.

**T1.4 — Optional JWT read path** · **M** (fast-follow, can slip to Phase 9)
HS256 verification middleware; claim = `{ pfx: "/streams/agents/team-x/", exp }`; applies to GET on `/streams/*` and `/shapes/*` only. A helper in the agents SDK for developers to mint tokens.
*Anticipate:* clock skew and token refresh mid-long-poll — allow small leeway and document that clients must reconnect with a fresh token on 401 (the resumable protocol makes reconnection cheap, which is the whole point).

### Phase 2 — Coordination core (Restate services)

**T2.0 — Restate semantics spike** · **M/L** · critical (gate)
Throwaway spike answering, with running code: (a) shared vs exclusive handler behavior while an exclusive invocation is long-running — can a shared handler deliver an interrupt flag / resolve a channel, and how does Restate's invocation-cancel API interact with an in-flight `ctx.run`; (b) journal-size behavior with large `ctx.run` results and the practical payload ceiling; (c) idempotency-key semantics on ingress invocations (retention window, retry/dedup behavior); (d) awakeable timeout and cancellation patterns; (e) replay behavior of an aborted `ctx.run`. Output: `SPIKE-RESTATE.md` with findings and recommended code patterns, referenced by T2.1/T2.2/T2.5/T4.1.
*Anticipate:* if any answer contradicts a D-decision (e.g. interrupt cannot reach a busy object), stop and redesign that seam before Phase 2 proceeds — this is the cheapest moment to discover it.

**T2.1 — Agent virtual object skeleton** · **L** · critical
`agent/<type>` object template with handlers: `spawn(args, parentRef?)`, `message(msg)`, `signal(sig)`, `archiveTick()`. K/V layout: `{ status, seq, outbox[], context[], workspaceRef, subscribers[], parentRef, usage }`. Invocation flow: validate → apply → run harness (Phase 3 stub) → collect events → project (T2.2) → notify (T2.3). One wake = one invocation; long chats = many invocations (bounded journals, R4).
*Anticipate:* **(a)** `ctx.run` result size — the harness returns events; if a run produces very large event arrays, chunk the return or write events to the outbox inside multiple `ctx.run` steps. **(b)** Handler-level reentrancy: Restate queues calls per key — verify that a slow harness run doesn't starve `signal`; if it does, model `signal` as a *shared* (concurrent read) handler that flags cancellation via Restate's invocation-cancel API rather than the mailbox. Formalized as T2.0 — T2.1 must not start before T2.0's findings land.

**T2.2 — Projection outbox + idempotent append** · **L** · critical
Implements D3 exactly: seq allocation, pending outbox in K/V, idempotent-producer append (`producerId` = entity url, sequence = our seq), confirm-and-trim, catalog `head_seq`/status upsert via `ctx.run`.
*Anticipate:* read the durable-streams PROTOCOL/client docs for the idempotent producer's exact semantics (producer epoch? per-producer sequence vs arbitrary keys?) — if its dedup key model differs from `(entityId, seq)`, add a thin mapping (e.g. producer per entity, producer-seq == our seq). If the server rejects out-of-order producer sequences after a gap, the outbox retry must replay *in order* from the first unconfirmed — design the trim logic for that from the start. Property-test this module heavily (simulate crash between append and trim; duplicate appends; reordered retries).

**T2.3 — Messaging, spawn, pub/sub** · **M** · critical
Parent→child spawn (one-way send with parentRef), `child_finished` back-send, `send` between arbitrary agents, subscriber notify on state change, debounce via delayed self-send + dirty flag. Dead-letter behavior: a send to a nonexistent/killed entity produces an `error` event on the *sender's* timeline (never silent).
*Anticipate:* fan-out completion ordering — a parent spawning N children gets N `child_finished` messages as separate invocations; provide a small SDK helper for "gather N results" as agent state, and cover the parallel-spawn case (the exact bug class we fixed upstream) in tests.

**T2.4 — Cron object** · **S**
`cron/<key>` virtual object: on tick, send target payload, compute next fire time from expression + timezone, delayed self-send. Reuse a vetted cron-parsing lib.
*Anticipate:* DST edge cases — take the boring path (lib with tz support, tests for the two DST transitions).

**T2.5 — Control API: interrupt + lifecycle verbs** · **M**
No POSIX signal cosplay — four plain verbs on the control surface. `interrupt(reason?)`: abort the in-flight harness run (AbortSignal plumbed through `ctx.run` → harness → LLM/tool calls; maps to the CASDK's interrupt for that harness), record a `control` event on the timeline, leave state consistent; the entity stays alive and immediately steerable/messageable. `pause` / `resume`: status flags checked at invocation start — a paused entity queues messages without processing them. `archive`: the T8.1 path, which also serves as "kill". Anything a `SIGUSR`-style custom signal would have carried is just a typed message.
*Anticipate:* depends on T2.0 findings for interrupt delivery while the exclusive handler is busy (shared-handler flag + invocation-cancel) and for replay behavior of an aborted `ctx.run` — document the resulting pattern in the package README. If `pause`/`resume` turn out to add complexity disproportionate to use, they are the cuttable half of this task; `interrupt` + `archive` are the non-negotiable core.

**T2.6 — Steerbox** · **S/M**
`steer/<entityId>` virtual object: `push(msg)` appends to a K/V queue; `drain()` returns-and-clears. The gateway routes `send(mode=steer)` here when the target is mid-run, else falls through to a normal message wake. Harnesses drain at their natural checkpoints (pi-ai: between steps; CASDK: in tool handlers and/or a light poll during the run) and inject into the live run.
*Anticipate:* the running/idle routing needs a cheap status read (catalog status or a shared read handler on the agent object). The race where a steer lands just as the run ends must lose no messages: agents also drain the steerbox at wake start, so a missed steer becomes the first input of the next wake.

### Phase 3 — Harness interface + pi-ai harness

**T3.1 — Harness interface** · **L** · critical
Finalize `Harness.run` signature per D5, plus the tool interface (`{ name, schema, execute(input, toolCtx) }` where `toolCtx` carries spawn/send/workspace clients + AbortSignal) and the context-assembly contract (canonical events → provider messages). The tool contract's load-bearing clause: **every side-effecting tool invocation goes through Restate ingress with idempotency key `(entityUrl, runId, toolUseId)`** — this is what makes tool effects exactly-once under any retry granularity, for both harnesses. Also defines `steerSource` (the drain interface harnesses poll at checkpoints). This is the seam both harnesses and the CASDK spike knowledge plug into — co-design with T0.1.
*Anticipate:* the delta channel (`emitDelta`) must be fire-and-forget and never block the run; if the stream server is down, deltas drop but the run proceeds and final events still land via the outbox. Make that a stated invariant with a test.

**T3.2 — pi-ai harness (fully step-durable loop)** · **M/L**
The owned loop, built on **pi-ai** (multi-provider LLM lib; electric agents' own `pi-adapter.ts` validates the fit). Per-step journaling: each LLM call is its own `ctx.run`; each tool call is a journaled Restate invocation; canonical events commit through the outbox at every step boundary; the steerbox is drained before each LLM step (steer messages injected as user input; optionally abort an in-flight generation when a steer arrives). Token deltas out-of-band. Context budget: accounting + `summarization` event when over budget (summary produced via a `ctx.run` LLM call).
*Anticipate:* per-step journaling requires the step loop to be deterministic *around* the journaled steps — no naked clock/random reads between `ctx.run` calls. Provider errors need retryable-vs-terminal classification; a completed `ctx.run` LLM call is never re-billed on replay. If pi-ai's streaming API resists clean step boundaries for some provider, buffer (non-streamed) for that provider rather than weakening journal granularity.

**T3.3 — Platform tools** · **M**
`spawn_agent`, `send_message`, `list_children`, `wait` (returns immediately — the *wake model* delivers results as messages; the tool's docstring must teach the model this), `finish`/`set_status`. Zod schemas + docstrings tuned for model use.
*Anticipate:* the async-result ergonomics ("spawn returns, result arrives on a later wake") confuse models; iterate on tool descriptions with real transcripts — budget a tuning pass.

### Phase 4 — Executors

**T4.1 — `workspace/<key>` object + executor host** · **L** · critical
Virtual object handlers: `ensure(config)`, `exec(cmd, opts)`, `fs.{read,write,mkdir,rm,stat,ls}`, `dispose()`. The object delegates to an executor host service (registered deployment) that owns the actual environment. Long-running exec: host returns quickly with an awakeable id it resolves on completion; stdout/stderr stream to a per-workspace durable stream in chunks; the awaited result is `{ exitCode, tailBytes, streamRef }` (R4).
*Anticipate:* **(a)** single-writer per workspace serializes all execs — correct for consistency, but a hung command blocks the workspace; enforce hard timeouts on the awaitable + a `SIGKILL`-style escape hatch handler (shared/concurrent). **(b)** Path containment: port the containment rules pattern from electric's sandbox layer (writes contained everywhere; document read semantics per adapter) rather than reinventing. **(c)** Restate ↔ host networking mirrors T1.2(b) — same explicit doc.

**T4.2 — Adapters: local + Docker** · **M**
`local-unrestricted` (dev only, loud warning) and `docker` (container per workspace, volume-backed, idle teardown with grace period). Adapter interface kept minimal so E2B/Firecracker slot in later.
*Anticipate:* Docker-in-Docker vs socket-mount decision for the compose dev environment — socket mount is simpler; document the security tradeoff.

**T4.3 — Agent tool bindings** · **M**
`bash`, `read_file`, `write_file`, `edit_file`, `ls` tools implemented over workspace calls; `workspaceRef` resolution from agent state; auto-`ensure` on first use.
*Anticipate:* edit-tool semantics (string-replace uniqueness) are a known model-ergonomics minefield — copy proven semantics (unique-match-or-fail) rather than inventing.

### Phase 5 — Observable plane & frontend SDK

**T5.1 — Stream layout, snapshots, retention** · **M**
One timeline stream per agent; deltas either interleaved as non-seq sub-events or a sibling `/deltas` stream (decide with T0.1 framing); periodic `state_snapshot` events; snapshot offset written to catalog. Retention/compaction policy on the streams server (if supported) or a documented "streams grow; archive closes them" stance for v1.
*Anticipate:* if the Rust server lacks per-stream truncation, don't build it — the archive lifecycle (T8.1) closing streams bounds growth per entity; note total-disk monitoring in T8.2 instead.

**T5.2 — Frontend SDK** · **L**
`createAgentTimeline(streamUrl, { fromSnapshot })` → materialized collections (runs, messages, toolCalls, liveDeltas) via reducer over `@durable-streams/client` reads (evaluate reusing `@durable-streams/state`; vendor if its coupling to electric's schema is too tight); `useAgentCatalog(shapeParams)` over Electric shapes; `actions` client (spawn/send/signal via gateway, API key or JWT); seq-gap detector surfacing a `driftDetected` signal. Framework-agnostic core + thin React bindings.
*Anticipate:* mid-stream join correctness — a client starting from snapshot offset must see snapshot(seq=N) then N+1, N+2…; write the conformance test first. Delta interleaving with finalized messages is the fiddly part (delta chunks for message m arriving around the finalized `message` event) — define the reducer's dedup rule (finalized event always wins) in the schema docs, not just code.

**T5.3 — Drift reconciler + repair** · **M**
Periodic job (a Restate service on a delayed-send loop): sample entities, compare catalog `head_seq` vs stream tail seq; mismatch → re-drive the entity's outbox flush; unrecoverable → emit `state_snapshot` + `history_hole` marker event and alert.
*Anticipate:* reading the "stream tail seq" cheaply requires either a tail-read API on the streams server or tracking last-confirmed-seq in catalog at trim time (do the latter — it's already in hand at T2.2 and avoids scanning).

### Phase 6 — Agents SDK (developer-facing)

**T6.1 — `defineAgent` API + registration** · **M** · critical
Typed definition: `{ type, spawnSchema, inboxSchemas, state (zod), harness: native(config) | claudeAgentSdk(config), tools[], onWake? }` compiled onto the T2.1 object template; deployment self-registration through the gateway on boot; type revisioning (bump on schema change; old instances keep old revision until archived).
*Anticipate:* schema evolution for live entities is the classic trap — v1 rule: state schemas are additive-only within a revision; breaking change ⇒ new revision ⇒ new instances only. Enforce in the SDK, document loudly.

**T6.2 — CLI + dev loop** · **M**
`platform dev` (compose up + register local services + tail logs), `platform agents ls|spawn|send|signal|logs <url>` (logs = follow the timeline stream, rendered). Fast iteration: watch-mode re-register on rebuild.
*Anticipate:* the register-before-server-up race electric agents has ("Stream not found" on boot order) — CLI waits on gateway health before registering; retries with backoff.

**T6.3 — Conformance kit** · **M**
A reusable test harness developers (and we) run against a live stack: spawn→respond, parallel fan-out with all `child_finished` delivered (the upstream bug, as a permanent regression test), crash-mid-run resume, projection continuity (no seq gaps through a streams-server restart), workspace exec survives agent-loop restart.

### Phase 7 — Claude Agent SDK harness

**T7.0 — Spike distillation** · **S/M**
A dedicated subagent whose only job is to produce `references/casdk-spike-digest.md` from `../electric`: read `CLAUDE_AGENT_SDK_PLAN.md` and the uncommitted diff (`git -C ../electric diff` + `status --porcelain`), and distill — findings, translation logic and where it lives (file paths into `../electric` for deep dives), edge cases discovered, what was completed vs abandoned, and anything contradicting teaspill's D5 design. The digest is what T7.1/T7.2 subagents receive; they open specific `../electric` files only via its pointers.
*Anticipate:* the source plan's task list describes work on the *electric* codebase — the digest must extract knowledge, never tasks or statuses, or downstream agents will try to "finish" the wrong plan. If `../electric` is absent, emit a stub digest saying so; T7.1 proceeds without the corpus at higher risk.

**T7.1 — Durable sessions + projection layer (warm/cold paths)** · **L** · critical
Implements D5's three CASDK layers. **Durable session storage:** SessionStore API (preferred; alpha) or session files, on a persistent volume or object store keyed by entity; each session stamped with the last canonical `seq` it reflects. **Warm path (normal wake):** stamp == canonical head → `resume` the durable session, feed the wake message via streaming input, run. A crashed-and-retried `ctx.run` re-resumes the same session and continues from the last persisted step — Claude Code interrupt/continue parity, obtained by the same mechanism Claude Code uses. **Cold path (recovery):** stamp mismatch or session lost → rebuild the session by projecting from canonical (canonical events with no CASDK equivalent become context notes; unknown CASDK records round-trip as `opaque` canonical events). **Capture:** translate emitted events to canonical at run end; finalized events also stream live during the run (T7.2). Golden fixtures per pinned SDK version: cold-projection → resume(no-op) → capture → canonical must be identity-modulo-ids; warm-resume equivalence is enforced by the seq stamp.
*Anticipate:* **(a)** format drift (R3): pinned version + fixtures turn breakage into a visible CI failure, and since projection is only the recovery path, drift cannot corrupt normal warm operation; keep the translation table in one file with per-version branches. **(b)** CASDK's internal compaction may rewrite session history mid-run — the seq stamp is updated only by *our* capture step, and canonical `summarization` events win on cold rebuild; verify resume tolerates a projected session longer than CASDK's own compaction would have kept. **(c)** ID mapping: bidirectional map in session metadata, regenerable. **(d)** The one remaining gap is session-storage loss combined with a crash between canonical commits: side effects are already protected by idempotent tools, so only trailing un-captured steps are lost — measure the window, keep capture cadence tight, document it. Seed the edge-case corpus from `references/casdk-spike-digest.md` (T7.0).

**T7.2 — Tool surface, observers, steering** · **M**
Strip built-ins (empty/disallowed tool list), bypass permissions (we own the toolset), no built-in subagents. In-process MCP server exposing exactly the T3.3 platform tools + T4.3 workspace tools with the shared `toolCtx` — including the T3.1 idempotency-key contract on every side-effecting call. **Hooks as observers only:** PostToolUse plus partial-message events (`includePartialMessages`) extract finalized events and token deltas live onto the stream; hooks never gate or redirect execution (we already own every tool — a control hook would hijack execution from ourselves). **Steering:** run in streaming-input mode; a drain loop (tool-handler checkpoints and/or a light poll) forwards steerbox messages into the query's input stream, and the engine injects them between tool calls — the same mechanism as CLI steering. The `interrupt` verb maps to the SDK's interrupt.
*Anticipate:* CASDK may hard-require some baseline tool or setting to run headless — enumerate the minimum viable configuration; if a built-in can't be disabled, wrap it to a no-op with a clear model-visible message. A steer that arrives after the model has already committed to a tool call still executes that call first (identical to Claude Code) — document so UI expectations match behavior.

**T7.3 — Runtime packaging** · **S**
Container image variant bundling the CASDK CLI subprocess; env plumbing (API key via gateway-issued secret env, model config); healthcheck that verifies the CLI boots.

**T7.4 — Delta + usage mapping** · **M**
Map CASDK streaming events (partial messages, tool starts) to the delta channel; map its usage/cost records into canonical `usage`; reconcile double-counting when Restate retries a failed run (usage events carry the invocation attempt id; frontend sums latest attempt only).

### Phase 8 — Lifecycle & operations

**T8.1 — Archival + resurrection** · **M/L**
Idle timer (delayed self-send reset on activity) → snapshot to catalog (`archived_snapshot`), terminal `archived` stream event, clear K/V, status=archived. Message to archived entity → rehydrate from catalog snapshot, status=active, continue seq from `head_seq`.
*Anticipate:* rehydration must be race-safe against a second concurrent message — single-writer makes it safe *if* rehydration happens inside the message handler itself (first invocation rehydrates, second sees live state). Snapshot size: it's the bounded context, not the timeline — enforce the bound at write time.

**T8.2 — Observability** · **S/M**
OTel traces across gateway→Restate→harness→executor (propagate context through sends); metrics: wakes/s, outbox depth, projection lag (head_seq vs confirmed), workspace pool, LLM token spend; compose-level dashboards optional.

**T8.3 — Backup/restore story** · **S**
Document + script: pg_dump, streams data dir snapshot, Restate snapshot config. State clearly which combinations restore cleanly (catalog+streams without Restate ⇒ active entities lost, archived fine — acceptable, documented).

### Phase 9 — Hardening & docs

**T9.1 — Failure injection suite** · **L**
Chaos tests on the compose stack: kill agent-loop mid-LLM-call (run resumes, no duplicate events); kill executor mid-exec (awakeable timeout → error event, workspace recoverable); kill streams server (runs proceed, deltas drop, outbox flushes on recovery, zero seq gaps); kill Restate (full stop, clean resume); gateway restart mid-long-poll (client resumes via protocol). Each maps to an invariant from D2/D3 — assert the invariant, not just "no crash".

**T9.2 — Docs** · **S/M**
Self-hosting guide (compose, networking assumptions from T1.2/T4.1, backup), agents SDK guide, frontend SDK guide, canonical schema reference, "differences from electric agents" positioning page, auth guide (API key + JWT read path).

---

## 6. Sequencing & gates

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 5 ──► Phase 6
                │             │          │
                │             └──► Phase 4 (parallel with 3 after T2.1)
                │
                └── T1.4 JWT can slip to Phase 9
Phase 7 starts after T3.1 + T6.1 (needs the harness seam + SDK shape)
Phase 8–9 close it out
```

Hard gates:
1. **T0.1 freeze gate:** schema frozen only after T3.1 exists and a T7.1 paper-mapping is written against it.
2. **T2.0 spike gate:** Restate semantics verified before T2.1–T2.6 and T4.1 build on them.
3. **T2.2 property tests green** before Phase 5 consumes the projection.
4. **R1 license check (T0.4)** before Phase 2 investment.

## 7. Task/model-size summary

| Task | Title | Size | Critical |
|---|---|---|---|
| T0.1 | Canonical event schema | L | ✔ |
| T0.2 | Addressing model | M | |
| T0.3 | Repo scaffold | S | |
| T0.4 | License verification (name: teaspill) | S | ✔ (gate) |
| T1.1 | Compose stack | S | |
| T1.2 | Gateway | L | ✔ |
| T1.3 | Catalog schema | S | |
| T1.4 | JWT read path | M | |
| T2.0 | Restate semantics spike | M/L | ✔ (gate) |
| T2.1 | Agent object skeleton | L | ✔ |
| T2.2 | Projection outbox | L | ✔ |
| T2.3 | Messaging/spawn/pubsub | M | ✔ |
| T2.4 | Cron object | S | |
| T2.5 | Control API (interrupt + verbs) | M | |
| T2.6 | Steerbox | S/M | |
| T3.1 | Harness interface | L | ✔ |
| T3.2 | pi-ai harness (step-durable) | M/L | ✔ |
| T3.3 | Platform tools | M | |
| T4.1 | Workspace object + host | L | ✔ |
| T4.2 | Local + Docker adapters | M | |
| T4.3 | Agent tool bindings | M | |
| T5.1 | Stream layout/snapshots | M | |
| T5.2 | Frontend SDK | L | |
| T5.3 | Drift reconciler | M | |
| T6.1 | defineAgent + registration | M | ✔ |
| T6.2 | CLI + dev loop | M | |
| T6.3 | Conformance kit | M | |
| T7.0 | Spike distillation digest | S/M | |
| T7.1 | CASDK durable sessions + projection | L | ✔ |
| T7.2 | CASDK tools, observers, steering | M | |
| T7.3 | CASDK packaging | S | |
| T7.4 | Delta/usage mapping | M | |
| T8.1 | Archival/resurrection | M/L | |
| T8.2 | Observability | S/M | |
| T8.3 | Backup/restore | S | |
| T9.1 | Failure injection | L | ✔ |
| T9.2 | Docs | S/M | |

Guidance for assignment: S tasks are safe for small models with the relevant D-decision pasted as context. M tasks need a mid model and the full section of this doc for their phase. L tasks need a large model, this whole document, and explicit permission to halt and escalate when reality contradicts a D-decision — the value of L tasks is in noticing exactly those contradictions early.

---

## 8. Orchestration guide (main session dispatching subagents)

This plan is executed by a main coordinating session that reads this document in full and dispatches one subagent per task, choosing model size from §7. **The kickoff prompt is simply: "Read PLAN.md and start work."** Everything the main session needs — initialization, protocol, dispatch order, reference handling — is in this section. No human setup beyond placing this file in an empty git repo (and optionally the sibling `../electric` repo, see 8.2).

### 8.0 Self-initialization (run once, before G1)

1. Confirm you are in a git repo containing this PLAN.md; `git init` if not.
2. Create `DECISIONS.md`, seeded with D1–D8 copied from §2 plus the line `name: teaspill`. Amendments get appended here over time.
3. Create an empty `WORKLOG.md` and a `references/` directory (for *digests* produced during the build — see 8.2 — plus any repos you clone yourself; add cloned repos to `.gitignore`, keep digests committed).
4. Check whether `../electric` exists (a sibling checkout of electric-sql/electric carrying the CASDK-spike working tree — see 8.2). If absent, note it in WORKLOG.md and proceed; only the tasks listed in the 8.2 table degrade.
5. Commit, then dispatch G1.

### Protocol for the main session

0. **Context hygiene for references.** Subagents are never handed `../electric` (or any reference repo) wholesale — it is large and contains a *different project's* plan and code, which will confuse or distract an agent that ingests it broadly. Access is always through the specific pointers in the 8.2 table, or through digest files in `references/` produced by dedicated distillation tasks (T7.0). When in doubt, distill first, then dispatch with the digest.

1. **Context per subagent.** Every subagent receives: (a) this entire document; (b) its task id; (c) the current `DECISIONS.md` and `WORKLOG.md`. For M/L tasks, additionally call out the specific D-decisions the task implements. S tasks may receive only §2 (decisions), their task text, and the ledgers if context is tight.
2. **Findings ledger.** Before finishing, every subagent appends one entry to `WORKLOG.md`: what it built, deviations from the task text, surprises, and open questions. If a finding contradicts a D-decision, the subagent writes a proposed amendment to `DECISIONS.md` and **halts that thread** — the main session (or Andrés) resolves it before any dependent task dispatches. This ledger is the connect-the-dots mechanism: later agents read it before starting.
3. **Definition of done (every task).** Code + passing tests in CI + WORKLOG entry. L tasks additionally leave a short design note in the package README.
4. **Integration review between groups.** After each dispatch group completes, the main session (or one M-sized reviewer subagent) reads the diffs + WORKLOG, runs the full suite, and reconciles any interface drift before dispatching the next group. Never pipeline groups.
5. **File-conflict rule.** Tasks in the same parallel group must touch disjoint packages. The groups below are constructed for that; if scope creep makes two live agents touch one package, serialize them immediately.
6. **Gates are absolute.** A group containing a gate task (T0.1 freeze, T0.4, T2.0, T2.2) never overlaps with its dependents.
7. **Prefer sequential under doubt.** Parallelism here buys wall-clock time, nothing else. If a group's independence is in question, run its tasks one by one — the plan loses only time.

### Dispatch groups (≤3 parallel subagents per group; groups strictly sequential)

| Group | Parallel tasks | Rationale / dependencies satisfied |
|---|---|---|
| G1 | T0.3 · T0.4 · T0.2 | Scaffold, license/name check, addressing model — fully independent. |
| G2 | (T0.1 + T3.1 as one L agent) · T2.0 · T1.1 | Schema and harness interface are co-designed and must be one agent's task; it also produces the T7.1 paper-mapping. Restate spike and compose stack are independent of it. |
| G3 | Schema freeze review (main session) · T1.3 · T2.4 | Gate 1: freeze T0.1 against the paper-mapping. Catalog and cron are S fillers in other packages. |
| G4 | T1.2 · T2.1 | Two L tasks in disjoint packages (gateway vs coordination). Keep the group at 2 — both need reviewer attention. |
| G5 | T2.2 · T4.1 · T1.4 | Outbox (coordination) ∥ workspace object (executor) ∥ JWT (gateway). All post-T2.0/T2.1. |
| G6 | T2.3 · T4.2 · T5.1 | Messaging ∥ sandbox adapters ∥ stream layout. Gate 3 check: T2.2 property tests must be green before this group ends. |
| G7 | T3.3 · T2.6 · T2.5 | Platform tools (harness pkg) ∥ steerbox ∥ control API. T2.5 and T2.3 both touch coordination — hence split across groups. |
| G8 | T3.2 · T4.3 · T5.3 | pi-ai harness (needs T2.2, T2.6, T3.3) ∥ workspace tool bindings ∥ drift reconciler. |
| G9 | T6.1 · T5.2 | defineAgent and frontend SDK — both integrative, both consume many interfaces; keep at 2 and budget a thorough review. |
| G10 | T6.2 · T6.3 · T7.0 | CLI ∥ conformance kit ∥ spike distillation (digest must exist before G11). |
| G11 | T7.1 · T7.3 · T8.2 | CASDK durable sessions (the hard L, fed the T7.0 digest) ∥ CASDK packaging ∥ observability. |
| G12 | T7.2 · T7.4 · T8.1 | CASDK tools/steering (needs T7.1, T2.6) ∥ delta/usage mapping ∥ archival. |
| G13 | T9.1 · T9.2 · T8.3 | Failure-injection suite is the acceptance test for D2/D3 invariants; docs and backup guide alongside. |

Interface-defining tasks (T0.1, T3.1, T6.1) and gate tasks never share a group with their dependents; parallel slots are filled with S/M tasks from unrelated packages. Within any group, if a subagent's WORKLOG entry proposes a D-amendment, hold the *next* group until it's resolved — dependents inheriting a contradicted decision is the failure mode this whole structure exists to prevent.

### 8.1 Repo layout

```
<parent>/
  teaspill/          # this repo — the main session runs here
    PLAN.md          # this document
    DECISIONS.md     # created in 8.0
    WORKLOG.md       # created in 8.0
    references/      # digests (committed) + self-cloned repos (gitignored)
    packages/...     # scaffolded by T0.3
  electric/          # OPTIONAL sibling, provided by Andrés — read-only
```

`../electric` is a checkout of electric-sql/electric whose **uncommitted working-tree changes are the CASDK-integration spike**, including a `CLAUDE_AGENT_SDK_PLAN.md` describing that (unfinished) initiative in detail. Nothing in `../electric` is ever modified.

### 8.2 The `../electric` reference — what it's for and how to touch it safely

References exist to lift *local, tactical patterns*, never architecture. **PLAN.md's D-decisions override anything found there** — electric agents' coordination architecture (wake registry, bridges, projectors, stream-as-entity-truth, POSIX signals) is exactly what teaspill replaces; copying it is the one forbidden move.

Two hard rules because the repo is large and carries a second plan:

- **`../electric/CLAUDE_AGENT_SDK_PLAN.md` is a plan for a different codebase.** Its tasks, statuses, and sequencing are NOT teaspill tasks and must never be imported into teaspill's WORKLOG/DECISIONS or treated as work to continue. It is raw material for the T7.0 digest only.
- **Separate spike from upstream.** The working tree mixes upstream code with uncommitted spike changes. To know which is which: `git -C ../electric status --porcelain` and `git -C ../electric diff --stat`. When a task needs the *pristine upstream* pattern from a file the spike modified, read the committed version via `git -C ../electric show HEAD:<path>`; when it needs the *spike*, read the diff.

| Task | Where to look in `../electric` | What to extract |
|---|---|---|
| T2.2 | `PROTOCOL.md` (repo root or durable-streams package) + idempotent-producer usage in `packages/agents-server/src/entity-bridge-manager.ts` | Producer/dedup semantics for the outbox |
| T4.1/T4.2 | `packages/agents-runtime/src/sandbox/` | Path-containment rules, adapter interface, docker lifecycle |
| T5.2 | `packages/agents-runtime/src/entity-stream-db.ts` + `@durable-streams/state` usage | Stream→collections materialization pattern (upstream version — `git show HEAD:` if spike-touched) |
| T3.2 | `packages/agents-runtime/src/pi-adapter.ts` | pi-ai integration shape |
| T4.3 | `packages/agents-runtime/src/tools/` | Proven tool semantics (edit uniqueness, read/write ergonomics) |
| T7.0 → T7.1/T7.2 | `CLAUDE_AGENT_SDK_PLAN.md` + the uncommitted diff | Distilled into `references/casdk-spike-digest.md`; T7.1/T7.2 receive the digest, not the repo |

Other references: the T3.2 agent may clone pi-ai into `references/` if npm docs prove insufficient; the T2.0 spike agent should fetch current Restate docs from https://docs.restate.dev rather than trusting training data (clone the Restate TS SDK examples into `references/` only if web access is unavailable).

### 8.3 Kickoff

The human prompt is one line: **"Read PLAN.md and start work."** Everything else — initialization (8.0), the protocol, groups G1→G13, gates (§6), sizing (§7), reference handling (8.2) — is this document's job, and the main session follows it without further instruction. Model mapping for dispatch: S → the smallest available model, M → a mid-tier model, L → the strongest available model. If a required capability is missing (no subagent support, no web access for T2.0), the main session notes the degradation in WORKLOG.md, adapts (serialize instead of parallelize; clone docs instead of fetching), and continues.