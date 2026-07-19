# Differences from electric agents

teaspill is a from-scratch rebuild of what ElectricSQL's "electric agents"
(electric.ax) promises — durable agents that run, spawn sub-agents,
communicate, share context, and stream their activity to UIs — but with a
**radically simpler coordination model**. This page explains what teaspill
keeps, what it changes, and what it drops, and why.

Sources: PLAN §1 (motivation) + §2 (decisions D1–D8), DECISIONS D1–D8.

---

## Why a rebuild

electric agents keeps the **same state in multiple stores** — durable streams
as event-sourced entity truth, Postgres tables, Electric shapes, in-memory
caches — with hand-rolled replication between them: bridges, projectors, outbox
drainers, and a wake registry synced from Postgres via Electric shapes into an
in-memory cache. **Every replication edge is a bespoke consistency problem.**

Observed consequences (bugs found and fixed upstream during the spike):

- dropped parent wakes on parallel sub-agent spawn (dual-path wake
  registration + stale cache rebuild),
- lost `message_type` in timeline materialization,
- undocumented Docker webhook loopback rewriting.

electric agents is also simultaneously a framework, a cloud service, a
desktop/mobile app, and a product. teaspill deliberately wants a **lean
subset**.

---

## What teaspill KEEPS

The core value proposition of the electric agents vision is preserved:

- **Durable entities with a wake model** — agents survive restarts and resume
  exactly.
- **Spawn / send / observe between agents** — multi-agent coordination.
- **Per-agent timelines streamable to browsers** over resumable, cacheable
  HTTP.
- **Realtime UI sync** — the catalog syncs to UIs via Electric shapes.

---

## What teaspill CHANGES

The architecture underneath is different by design:

| Concern              | electric agents                                                    | teaspill                                                                                     |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Coordination         | Wake registry, bridges, projectors, in-memory caches synced across stores | **All coordination moves to Restate** — virtual actor model + durable execution (D2). |
| Source of truth      | Durable streams are event-sourced **entity truth**, replicated everywhere | Restate K/V is the **only** store consulted for control flow (D1). Streams and Postgres+Electric are demoted to **write-only projections**. |
| Streams              | Stream-as-entity-truth; read to decide what to do; compaction protocol | **Authoritative history/telemetry only** — append-only, browser-readable, resumable, cacheable, **never read to decide what to do** (D1). |
| Service topology     | One conflated runtime                                             | **Two independently scalable planes** — agent-loop services (scale on LLM concurrency) and an executor fleet (scale on workspace demand) (D4). |
| Harness              | Fixed                                                             | **Pluggable behind one interface** — a native Anthropic-API loop and the Claude Agent SDK, swappable per agent (D5). |
| Exactly-once writes  | Hand-rolled outbox drainers across replication edges              | **One outbox protocol** — per-entity 0-based-gapless `seq`, committed atomically under single-writer, keyed `(entityId, seq)` on the durable-streams idempotent producer (D3). |

The guiding principle: **one owner per concern** (D1). Restate K/V owns live
state and control flow; Postgres owns the entity registry + the archive of
record; durable streams own history/telemetry. There is no bidirectional
replication to keep consistent — projections flow **one way**, out of the agent
handlers.

---

## What teaspill DROPS

Explicitly out of scope (D8) — these are the moving parts whose replication
edges caused the bugs above, plus product surface teaspill doesn't need:

- **The wake registry** and conditional collection-change wakes — Restate's
  virtual-object addressing and durable sends replace them. Spawn is a one-way
  durable send carrying the parent's key; completion is the child sending
  `child_finished` back. No registry to keep in sync.
- **The pgSync bridge**, **tag streams + outbox drainer**, and the **entity
  projector** — the replication machinery between stores.
- **Dual webhook/pull-wake delivery** — one delivery path.
- **Stream-as-entity-truth materialization + compaction protocol** — teaspill
  keeps only **simple snapshot events** (`state_snapshot`); no compaction
  protocol.
- **Desktop / mobile apps** and **built-in Horton/Worker agents** — teaspill is
  a framework + self-host platform, not a bundled product.
- **Platform-level principals / permissions** — no scoping model at the
  platform layer; the developer proxies and implements authz (D6). Writes never
  bypass the developer.
- **Multi-tenancy** — **single-tenant per deployment; a tenant is a
  deployment.** (The address model reserves a tenant segment for naming, but
  Restate keys carry no tenant — A2.)
- **The MCP *bridge* package** — teaspill still **serves** MCP tools to the
  Claude Agent SDK harness in-process, but there is no bridge package.
- **Mid-session executor switching** — a workspace is chosen at spawn/config
  time and kept (`workspaceRef` in agent state, D4).
- **The POSIX signal vocabulary** (`SIGINT`/`SIGSTOP`/`SIGCONT`/`SIGTERM`/…) —
  agents are not processes. Replaced by a **minimal control verb API**:
  `interrupt`, `pause`/`resume`, `archive` (D8/T2.5). Custom control needs are
  expressed as typed messages. (This is why the canonical event type is
  `control`, not `signal`.)

---

## The two service planes, at a glance

```
   ┌──────────────┐        ┌───────────────────────────┐
   │ agent-loop   │        │  executor fleet            │
   │ services     │        │  workspace/<key> objects   │
   │ (stateless   │        │  fronting Docker / local / │
   │  replicas,   │        │  remote environments       │
   │  run         │        │  (serialized per workspace,│
   │  harnesses)  │        │   long execs via awaitables)│
   └──────┬───────┘        └────────────┬──────────────┘
          │  registered with Restate    │
          └───────────► Restate ◄────────┘   ← coordination core (K/V, sends, durable execution)
                          │
              projections (one-way, out of handlers)
             ┌────────────┼─────────────────┐
             ▼            ▼                  ▼
        durable-streams  Postgres catalog   (Electric shapes → UIs)
         (history)       (registry+archive)
```

Both planes scale independently; neither is the source of truth for the other.

---

## Where to go next

- [self-hosting.md](./self-hosting.md) — run the stack.
- [agents-sdk.md](./agents-sdk.md) — write agents.
- [schema-reference.md](./schema-reference.md) — the canonical event vocabulary.
- [addressing.md](./addressing.md) — the naming model that ties entities,
  streams, workspaces, and Restate objects together.
