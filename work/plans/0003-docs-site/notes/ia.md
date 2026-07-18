# teaspill docs — information architecture (T2.1)

The complete page tree for the public site, mapped to the template structure
(`packages/docs/content/`). Per page: owner task, wave, pattern (per style-guide §2),
target length, outline, and source-material pointers. Read with `notes/style-guide.md`.

Conventions used below:
- **Owner** = the T3.x task that writes the page. Wave 1 = T3.2/T3.5/T3.6 (frozen
  surfaces, run now); Wave 2 = T3.1/T3.3/T3.4/T3.7 (runtime-behavior pages, wait for
  Gate 2).
- **Pattern** A = Nuxt hub, B = Laravel task page (style-guide §2).
- Lengths are prose-word targets excluding code blocks; ±30% is fine, longer is not.
- "Sources" are *material* pointers, not citations — public pages never name them (D4).
- Every page: frontmatter `title`, `description`, `navigation.icon`; directory
  `.navigation.yml` sets group title + icon.

Template placeholders `content/2.essentials/` and `content/3.ai/` are deleted by T3.7
(Wave 2, after real sections exist). `content/1.getting-started/3.usage.md` (template
placeholder) is replaced by the real Getting Started set below.

---

## Page tree at a glance

```
content/
  index.md                                     landing            T3.1  W2
  1.getting-started/
    1.index.md          Introduction           T3.1  W2
    2.installation.md   Installation           T3.1  W2
    3.quick-start.md    Quick start            T3.1  W2
    4.architecture.md   Architecture overview  T3.1  W2
  2.concepts/
    1.durable-agents.md      Durable agents & the wake model   T3.2  W1
    2.restate-primer.md      Restate in five minutes           T3.2  W1
    3.entities-addressing.md Entities & addressing             T3.2  W1
    4.timelines-events.md    Timelines & events                T3.2  W1
    5.projections-catalog.md Projections & the catalog         T3.2  W1
    6.workspaces.md          Workspaces & execution            T3.2  W1
    7.harnesses.md           Harnesses                         T3.2  W1
    8.multi-agent.md         Multi-agent patterns              T3.2  W1
    9.lifecycle.md           Lifecycle & control               T3.2  W1
    10.glossary.md           Glossary                          T3.2  W1
  3.guides/
    .navigation.yml                            (owned by T3.3 — created in G4)
    1.agents/
      1.building-agents.md       Building agents               T3.3  W2
      2.frontend-integration.md  Frontend integration          T3.3  W2
    2.operations/
      1.self-hosting.md          Self-hosting                  T3.4  W2
      2.auth-api-keys.md         Auth & API keys               T3.4  W2
      3.backup-restore.md        Backup & restore              T3.4  W2
  4.reference/
    1.events.md          Event schema            T3.5  W1
    2.addressing.md      Addressing              T3.5  W1
    3.gateway-api.md     Gateway HTTP API        T3.5  W1
    4.cli.md             CLI                     T3.5  W1
    5.configuration.md   Configuration           T3.5  W1
  5.contributing/
    1.index.md           Contributing            T3.6  W1
    2.package-map.md     The package map         T3.6  W1
  changelog/             (T1.3 collection — /changelog page, outside the docs sidebar)
```

Conflict/path note for G4: T3.3 and T3.4 share `content/3.guides/` but own **disjoint
subdirectories** (`1.agents/` vs `2.operations/`), each with its own `.navigation.yml`.
The parent `content/3.guides/.navigation.yml` is created by **T3.3 only** (a two-line
file); T3.4 never touches it. This satisfies the path-disjointness rule.

Changelog stays a separate collection (T1.3): excluded from the docs sidebar/search,
rendered at `/changelog`, entries in `content/changelog/*.md`. New entries are authored
per release in the public voice; no T3.x work beyond keeping the v1 entry accurate.

---

## Landing — `content/index.md` · T3.1 · W2 · MDC hero page · ~250 words of copy

The 30-second pitch: **durable AI agents that survive restarts, spawn sub-agents, and
stream everything to your UI.** Hero (title, description, CTA → Introduction +
GitHub), 6 feature cards (durability, multi-agent, live UI streaming, pluggable
harnesses, self-hosted 5-service stack, single-entrypoint auth), a short code teaser
(`defineAgent` ~15 lines), CTA section → quick start.
Sources: `docs/README.md` intro para; `docs/agents-sdk.md` end-to-end example;
template `content/index.md` for MDC component usage (`::u-page-hero`,
`::u-page-section`, `::u-page-feature`, `::u-page-c-t-a`).
Ramp: R1/R2 only; feature-card copy may not use undefined jargon.

## 1. Getting Started (T3.1 · Wave 2)

### 1.1 `1.index.md` — Introduction · Pattern A · ~700 words · zero/near-zero code
Model: Nuxt's introduction page. Outline:
- Opening promise: what teaspill is, in R1 terms.
- The problems it removes (problem-first, style-guide §1): agents die mid-run;
  multi-agent coordination is fragile plumbing; streaming agent activity to a UI means
  building your own event pipeline; "where is the state?" has five answers.
- What using it looks like: define agents in TypeScript, run a small self-hosted stack,
  spawn/send/watch from your app. One sentence on Restate (ramp note, style-guide §4).
- What's in the box (bullets: SDKs, gateway, CLI, reference deployment).
- Who it's for / what it is not (self-hosted framework, not a SaaS; you own authz).
- "Read more" spokes to Concepts + quick start.
Sources: `docs/README.md`, `docs/differences-from-electric-agents.md` (KEEPS list only,
reframed as capabilities), PLAN §1 background (voice only, no ids).

### 1.2 `2.installation.md` — Installation · Pattern A (sequenced) · ~800 words
Model: Nuxt's installation page. Outline:
- Prerequisites (Docker + compose plugin, Node 20+, pnpm, an Anthropic/provider key for
  the demo agents — versions per root `package.json` engines).
- Clone → `cp .env.example .env` (+ bootstrap API key for dev) → bundle gateway +
  reference deployment → `docker compose -f docker-compose.yml -f
  docker-compose.overlay.yml up -d --build` (or `teaspill dev` with `COMPOSE_FILE`).
- Success checkpoint: `GET /health`, `teaspill agents ls` runs clean.
- What you just started: one-paragraph tour of the five services + the two
  developer-deployed services (names only, links to architecture page).
- `::warning` — the one networking rule (host-run services register
  `host.docker.internal`, never `localhost`).
- Next steps → quick start.
Sources: `packages/reference-deployment/README.md` (Getting started block — the
authoritative sequence), `docs/self-hosting.md` (compose stack, env),
`.env.example`, `Makefile`. Verify every command live (Gate 2 guarantees the overlay).

### 1.3 `3.quick-start.md` — Quick start · Pattern B walkthrough · ~1,200 words
The single highest-value page. One linear build on the running stack from Installation:
- Define a `researcher` agent (spawnSchema/state/native harness) — file-labeled block.
- Serve + register it (`serve(...)` snippet or run inside the reference deployment;
  base on the reference-deployment example; decide at writing time which is shorter,
  record in WORKLOG).
- Spawn it (`teaspill spawn researcher '{"topic":"the history of tea"}'`) and send a
  follow-up (`teaspill send …`).
- Watch it: `teaspill logs <url>` **and** the timeline in a browser (minimal
  `createAgentTimeline` HTML/React snippet) — the "stream everything to your UI" payoff.
- Make it multi-agent: add the `summarizer` child, show `child_finished` arriving on a
  later wake (previews R5 with a link).
- Next steps: three links (Concepts, Building agents, Frontend integration).
Every block must run verbatim against the current repo — run them.
Sources: `docs/agents-sdk.md` end-to-end example, `packages/reference-deployment`
(demo agents, loose-message normalization), `packages/cli` commands,
`docs/frontend-sdk.md` timeline snippet.

### 1.4 `4.architecture.md` — Architecture overview · Pattern A · ~900 words + 1 diagram
The two-planes + one-owner-per-concern picture, redrawn didactically and **stripped of
all comparison framing** (see "Comparison material" verdict below). Outline:
- Opening: the whole system in one paragraph.
- Diagram (mermaid or SVG): gateway in front; Restate coordinating; agent-loop plane and
  executor plane; projections flowing one way to streams + catalog(+Electric) → UIs.
- One owner per concern: three stores, three jobs (working state / history / registry+
  archive) — as a positive design principle with a "why" line each.
- The two planes you deploy (agent-loop, executor) vs the infrastructure you run
  (compose stack).
- Design principles box (neutral rationale, no competitor mentions): projections flow
  one way; history is never control flow; writes never bypass your backend; one
  deployment = one tenant; a small control-verb vocabulary instead of process signals.
  Each principle gets a "Roughly + accordion" treatment where precision needs depth.
- Spokes to each Concepts page (this page is the guided map of the ramp, defining
  nothing — style-guide §4 note).
Sources: `docs/differences-from-electric-agents.md` (CHANGES table + planes diagram +
DROPS list, rewritten as neutral rationale), `docs/self-hosting.md` deployment model.

## 2. Concepts (T3.2 · Wave 1) — the didactic core; write and read in ramp order

### 2.1 `1.durable-agents.md` — Durable agents & the wake model · A · ~800 words
Defines R3 (durable execution), R4-informal ("your agent is a single object that
handles one thing at a time"), R5 (wake). Outline: the crash problem → durable
execution in plain terms (journal of steps, resume not restart) → the wake model (turn
lifecycle: something arrives → agent wakes → acts → sleeps; **nothing ever blocks** —
`wait` returns immediately, results arrive as later wakes) → what this buys you
(agents that survive deploys; no polling loops; ordered, replayable behavior) → spokes
(Restate primer, Lifecycle). The spawn-returns-immediately/`child_finished`-later
mental model from the SDK tool descriptions is the load-bearing teaching here.
Sources: `docs/agents-sdk.md` (platform tools + async-wake model),
`packages/coordination/README.md` (wake-input convention — background only),
`packages/harness-native/src/tools.ts` (tool description text — verify claims).

### 2.2 `2.restate-primer.md` — Restate in five minutes · A · ~700 words
For devs who've never heard of Restate. Defines R4 formally (virtual object,
single-writer). Outline: what Restate is (open-source durable-execution engine;
teaspill runs it as one of its services — you never talk to it directly) → virtual
objects (named instances, state, one invocation at a time — and why single-writer
ordering is what makes timelines trustworthy) → durable sends (fire-and-forget that
can't be lost — what spawn/send ride on) → what teaspill hides from you vs what leaks
through usefully (registration URLs, the dialing rule — link to self-hosting) →
`::note` linking restate.dev for depth.
Sources: `docs/differences-from-electric-agents.md` (coordination row),
`docs/self-hosting.md` (registration), restate.dev docs (link only).

### 2.3 `3.entities-addressing.md` — Entities & addressing · A · ~600 words
Defines R6. Outline: every agent instance is an entity with one URL-shaped id →
anatomy of `/t/default/a/researcher/01j…` (tenant/type/id, one line each; tenant is
constant per deployment) → the short form `/a/<type>/<id>` accepted by the API/CLI →
ids: generated (sortable ULIDs) vs caller-supplied (deterministic spawn = idempotent
re-spawn; accordion: how reattach behaves) → the same id appears in catalog rows,
events, stream URLs (one glance-table) → spoke to the Addressing reference for the
full grammar.
Sources: `docs/addressing.md` §0–3 (TL;DR table, id rules),
`packages/schema/src/addressing.ts` (verify forms/limits).

### 2.4 `4.timelines-events.md` — Timelines & events · A · ~900 words
Defines R7, R8, R11(snapshot). Taught, not specified — the spec lives in the Event
schema reference. Outline: the timeline is the append-only story of one entity →
numbered events, `seq` 0,1,2… no gaps (why gaplessness matters: you can trust "did I
miss anything?") → tour of the vocabulary by *scenario*, not table (a wake: run_started
→ message/tool_call/tool_result/reasoning → run_finished; a family: child_spawned /
child_finished; lifecycle: control, state_snapshot, archived) → token deltas: the live
sibling channel, droppable, finalized-event-wins → snapshots: join late without
replaying everything → "history, never control flow" (Roughly + accordion) → spokes
(Event schema reference, Frontend integration).
Sources: `docs/schema-reference.md`, `docs/streams.md` §1–2,
`packages/schema/src/events.ts` + `deltas.ts` (verify: 15 types, envelope fields).

### 2.5 `5.projections-catalog.md` — Projections & the catalog · A · ~700 words
Defines R9, R10. Outline: the write side vs the read side → projections: everything
you can read (timeline, catalog rows) is copied one way out of the agent's handler;
nothing is read back to make decisions → exactly-once in one sentence + accordion
("Under the hood: the outbox") naming the mechanism for the curious → the catalog:
registry of entities (type/status/parent/tags/head_seq), synced live to clients via
Electric shapes → what to build on which (lists/dashboards ← catalog; conversation
detail ← timeline; commands → the API) → spokes (Frontend integration, package map).
Sources: `docs/differences-from-electric-agents.md` (one-owner principle),
`packages/catalog/README.md`, `packages/coordination/README.md` (outbox — accordion
depth only), `docs/frontend-sdk.md` (catalog section).

### 2.6 `6.workspaces.md` — Workspaces & execution · A · ~700 words
Defines R12. Outline: agents that touch the world need a place to run commands → a
workspace is a sandboxed environment (filesystem + shell) fronted by its own
serialized object → chosen at spawn, fixed for life; private (default, derived name)
vs shared (named) workspaces → the executor plane: hosts environments via adapters
(docker default; container-per-workspace, volume persists across execs) → scale
story: agent concurrency and workspace demand scale independently → long commands:
output streams live, results return to the agent when done (no journal bloat —
accordion) → `::caution` on the Docker socket trust boundary (one paragraph, link to
Self-hosting for the full story).
Sources: `docs/self-hosting.md` (executor section), `packages/executor/README.md`,
`docs/addressing.md` §5 (workspace keys).

### 2.7 `7.harnesses.md` — Harnesses · A · ~700 words
Defines R13. Outline: the harness runs the model loop inside a wake; pick per agent →
tiered nutshell (style-guide §2): native = teaspill owns the loop, any provider,
finest-grained durability — the default; Claude Agent SDK = Claude Code semantics
(sessions, compaction) when you want that behavior → what's identical regardless
(same tools, same timeline events, same exactly-once tool guarantees) → durability
difference in plain words: native journals every step; the SDK harness keeps a durable
session and can rebuild it from the timeline if lost (accordion: warm vs cold) → spoke
to Building agents for config.
Sources: `docs/agents-sdk.md` (harness selection), `packages/harness-casdk/README.md`
(three layers — accordion depth), `packages/harness-native/README.md`.

### 2.8 `8.multi-agent.md` — Multi-agent patterns · A · ~800 words
Uses R1–R13; defines nothing new (steer waits for 2.9 — don't use it here). Outline:
spawn/send/observe as the whole coordination surface → the golden rule restated:
spawn returns an id immediately; the result is a later `child_finished` wake → patterns
with mini-code: fan-out/gather (N children in one wake, count results in state);
pipeline (chain via send); deterministic spawn for idempotent workers (caller-supplied
ids); watching another agent (subscribe to its catalog row / timeline) → parent wakes:
what arrives, in what shape → anti-patterns `::warning` (waiting synchronously;
polling; using timelines as a message bus).
Sources: `docs/agents-sdk.md` (tools, example), `packages/conformance/README.md`
(fan-out scenario as the canonical pattern), `packages/reference-deployment/README.md`
(fanout agents).

### 2.9 `9.lifecycle.md` — Lifecycle & control · A · ~800 words
Defines R14, R15, R16. Outline: an entity's states (active/idle/archived) in one
diagram → the four control verbs, one paragraph each (interrupt stops the current run
cleanly and the agent stays messageable; pause/resume; archive) → idle auto-archive:
the default cost model (accordion: what exactly is stored where when archived) →
resurrection: send to an archived agent and it's back — same URL, same timeline,
numbering continues → steer: talk to an agent mid-run; degrades to a normal message →
"custom control = typed messages, not new verbs" → spokes (Gateway API reference for
the control route, Backup & restore for durability of archives).
Sources: `docs/schema-reference.md` (control/archived events),
`packages/coordination/README.md` (interrupt seam — accordion depth only),
`docs/agents-sdk.md` (archiveCatalog note), gateway README (control route).

### 2.10 `10.glossary.md` — Glossary · spec in style-guide §7 · ≤ 1,200 words

## 3. Guides

### 3.1 `3.guides/1.agents/1.building-agents.md` — Building agents · T3.3 · W2 · B · ~2,200 words
The defineAgent task page, Laravel-style: quick complete example first, then the
rulebook. Outline: a complete minimal agent (≤ 30 lines) → `defineAgent` field-by-field
(type, spawnSchema, inboxSchemas, state, tools, tenant) — claim → code → variation per
field → choosing a harness (config tables for `native(...)` and `claudeAgentSdk(...)`;
the tiered nutshell links back to Concepts/Harnesses) → the platform tools your agent
gets (six, table + the async mental model restated in two sentences) → workspace tools
(five, when `workspace: true`) → restricting tools (`include` lists) → `onWake`
(deterministic hook; falsy = hand off, `{handled:true}` = no LLM; when to use — testing,
routing, pure logic agents) → state revisions (additive-only rule; baseline;
`StateRevisionError`; when to bump) → serving & registration (`serve`, CompileDeps in
one honest paragraph + accordion; the registration URL rule `::warning`) → testing your
agent (compileConfig against fakes; conformance kit pointer).
Sources: `docs/agents-sdk.md` (primary), `packages/agents-sdk/README.md`,
`packages/harness-native/src/{tools,workspace-tools}.ts` (verify names/behavior),
`packages/reference-deployment/README.md` (loose-message normalization — include as a
variation), `packages/agents-sdk/src/*` (verify signatures — 0002 may have moved them).

### 3.2 `3.guides/1.agents/2.frontend-integration.md` — Frontend integration · T3.3 · W2 · B · ~1,800 words
Outline: what the SDK gives you (three clients, one per route family — nutshell) →
actions client (spawn/send/control; spawn returns `url` + `streamUrl`) → reading a
timeline (`createAgentTimeline`; subscribe; render messages + liveDeltas) → auth in the
browser (read tokens: mint server-side, refresh per request, 401 = reconnect cheaply)
→ fast-join (catalog row → `fromSnapshot: { seq, offset? }`; **document the stream
offset** — the internal guide lags here, see style-guide §9.6) → the three ordering
rules as user-facing guarantees (dedup handled for you; snapshot-join equivalence;
finalized-wins) with the drift callback + history-hole UX (`::note` on rendering a
gap) → catalog subscriptions (`createAgentCatalog` filters) → React bindings → SSR
note (reducer is pure; usable server-side).
Sources: `docs/frontend-sdk.md`, `packages/frontend-sdk/README.md`,
`packages/frontend-sdk/src/{timeline,reducer,catalog,actions,react}.ts` (verify),
`docs/auth.md` (read-token path).

### 3.3 `3.guides/2.operations/1.self-hosting.md` — Self-hosting · T3.4 · W2 · B · ~1,800 words
Outline: deployment model diagram (compose infra + your two planes) → the five
services, one row each → env configuration (defaults-work stance; the table distilled)
→ running it: `teaspill dev` (primary) / raw compose + overlay (the reference
deployment as the worked example) → **networking rules** (the section every operator
reads: register service-name in-network, `host.docker.internal` from the host, never
localhost — `::warning`; why, in two sentences + accordion for the dialing rationale;
published ports are debug-only) → the executor & the Docker socket (`::caution`:
root-equivalent; single-tenant stance; hardening knobs: digest-pinned image,
per-workspace network mode; what hardening does NOT cover) → production checklist
(change Postgres password, ELECTRIC_INSECURE=false, real API keys, JWT secret, TLS in
front of the gateway) → scaling notes (planes independent; single-node Restate stance)
→ pointer to Backup & restore.
Sources: `docs/self-hosting.md` (primary), `docs/self-hosting-networking.md`
(absorbed — the rules + rationale), `docker-compose.yml` + overlay,
`packages/reference-deployment/README.md` (env table), `packages/executor/README.md`
(socket tradeoff), `packages/gateway/README.md` (env vars).

### 3.4 `3.guides/2.operations/2.auth-api-keys.md` — Auth & API keys · T3.4 · W2 · B · ~1,100 words
Outline: the two paths, nutshell (API keys = server-side, everything; read tokens =
optional, browser reads only) → API keys (`teaspill keys create/ls/revoke` — the
primary flow; needs DATABASE_URL, why it's a DB command — accordion "Why isn't there a
mint route?"; bootstrap key for dev `::warning` dev-only) → programmatic minting
(`createApiKey` from `@teaspill/catalog`) → the read-token path (enable via
GATEWAY_JWT_SECRET; mint with `mintReadToken`; prefix claim with trailing-slash rule
`::warning`; short TTLs + cheap reconnect; reads-only guarantee stated plainly: a read
token can never spawn/send/control) → CORS for browser reads (defaults; pinning
origins) → "you own authorization" (no platform permissions model — your backend
decides who may do what; this is a design stance, one honest paragraph) → env table.
Sources: `docs/auth.md` (current — prefer over gateway README per style-guide §9.2),
`packages/cli/src/commands/keys.ts` (verify flags), `packages/gateway/src/{auth,jwt}.ts`.

### 3.5 `3.guides/2.operations/3.backup-restore.md` — Backup & restore · T3.4 · W2 · B · ~1,400 words
Outline: what each store owns, in public words (catalog+archives / history /
working-set cache) — the asymmetry stated up front: losing working state is designed
to be survivable for archived agents → taking a backup (`scripts/backup.sh`; quiesced
default vs `--live` and what "torn" costs — `::caution`) → restoring
(`scripts/restore.sh` subsets) → **the restore matrix taught as "what combinations
restore cleanly"**: full = clean; catalog+streams without the coordination store =
archived agents fine (they resurrect), never-archived agents lose their in-flight
state (loudly, not silently — describe the visible failure) — and the mitigation
(shorten the idle-archive window or always restore all three); coordination+catalog
without streams = everything keeps running, the timeline shows a marked history gap;
other subsets = don't → scheduling is yours (cron pointer) → verify-your-backup tip.
Sources: `docs/backup-restore.md` (primary — already public-adjacent; strip ledger
framing), `scripts/{backup,restore}.sh` headers (verify flags).

## 4. Reference (T3.5 · Wave 1) — Pattern B spec variant; terse, table-driven

### 4.1 `1.events.md` — Event schema · ~1,600 words + tables
Stays close to a spec; still public voice (no decision ids, no "frozen at gate" —
say "stable: additive-only changes within v1"). Outline: envelope table
(v/entityId/seq/ts/type/payload) → the seq guarantees (0-based, gapless, first event
is `entity_spawned`; snapshots occupy slots) → the 15 types: one table + per-type
subsection (payload shape in a `ts` block + 1–3 sentences; keep the schema-reference's
excellent per-type notes, public-voiced) → shared fragments (ContentBlock, RunUsage) →
token deltas (the four kinds; no-seq; finalized-wins) → helper functions exported from
`@teaspill/schema` (table).
Sources: `docs/schema-reference.md` (primary), `packages/schema/src/{events,deltas}.ts`
(verify every field — the code is the spec).

### 4.2 `2.addressing.md` — Addressing · ~1,000 words + tables
Outline: the one-glance table (entity URL, short form, stream paths, workspace keys —
the addressing.md §0 table minus Restate internals) → segment grammar + length limits
(the regex, why lowercase-only in one sentence) → instance ids (ULID default;
caller-supplied rules) → stream paths (timeline/deltas/workspace stdout; gateway
`/streams` prefix) → workspace keys (private derivation, shared naming) → helpers in
`@teaspill/schema` (function table: entityUrl/parseEntityUrl/timelineStreamPath/…).
Restate service/key mapping moves to the package map (contributor-facing); mention in
an accordion at most.
Sources: `docs/addressing.md` §0–5, §9, `packages/schema/src/addressing.ts` (verify).

### 4.3 `3.gateway-api.md` — Gateway HTTP API · ~1,200 words
The actions client wraps this; document it as the platform's public API. Outline:
base URL + auth header → route table → per route: request/response shapes with `sh`
curl examples (`POST /api/spawn` incl. 202 body `{ url, streamPath, streamUrl,
restate }`; `POST /api/a/:type/:id/send`; `POST /api/a/:type/:id/control`;
`GET /streams/*` semantics: resumable, offsets, long-poll, caching — reader-level
only; `GET /shapes/*`; `/registry/*` for deployments) → idempotency keys on commands →
status codes & errors (401/403 read-token semantics; 413 body cap) → CORS behavior
summary.
Sources: `packages/gateway/README.md` (route table), `packages/gateway/src/routes/*`
(verify shapes — the spawn response shape is confirmed in `api.ts`), `docs/auth.md`.

### 4.4 `4.cli.md` — CLI · ~1,200 words
Outline: install/run (workspace bin; via the repo today) → global configuration
(flags/env table) → per command: synopsis, flags, example, sample output —
`dev` (incl. `--watch` contract: watches built output, you run the build),
`agents ls`, `spawn`, `send`, `control`, `logs` (`--deltas`, `--from-snapshot`),
`keys create|ls|revoke` (needs DATABASE_URL; prints token once). **Derive the command
set from `packages/cli/src/cli.ts`, not the package README** (README lags — no `keys`).
Sources: `packages/cli/src/cli.ts` + `src/commands/*` (primary), `packages/cli/README.md`
(background), `docs/auth.md` (keys).

### 4.5 `5.configuration.md` — Configuration · ~1,000 words, tables
One page, every knob, grouped by surface: compose/.env (ports, credentials,
ELECTRIC_INSECURE…) → gateway env (full table incl. body cap, timeouts, JWT, CORS,
OTEL) → client/CLI env (TEASPILL_GATEWAY_URL/API_KEY/TENANT/DEPLOYMENT_URL) →
reference-deployment/agent-loop env (PORT, TEASPILL_INGRESS_URL, TEASPILL_MIGRATE,
TEASPILL_RECONCILER, adapter selection, demo gating) → workspace/executor knobs
(adapter image/network options) → each row: default + one-line meaning; longer stories
link to the owning guide page.
Sources: `docs/self-hosting.md` env table, `packages/gateway/README.md` env table,
`packages/reference-deployment/README.md` env table, `packages/cli/README.md` config,
`.env.example`, compose files (verify defaults against `docker-compose.yml`).

## 5. Contributing (T3.6 · Wave 1)

### 5.1 `1.index.md` — Contributing · A · ~700 words
Up-front framing: "You only need this section if you're working on teaspill itself."
Outline: repo layout in one paragraph (pnpm workspace, packages/) → running the repo
(install, `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint`; tests skip live-infra
suites without a stack — how to opt in via env) → conventions (conventional commits;
TypeScript/ESM; pinned versions stance) → **where design history lives**: the one
sanctioned `work/` pointer, exact wording per style-guide §5 → how the docs site
itself is built (packages/docs, dev/generate) → spoke to the package map.
Sources: root `CLAUDE.md`/`AGENTS.md` (build/test bar), `work/README.md` (pointer
target), root `package.json`.

### 5.2 `2.package-map.md` — The package map · table + sections · ~2,400 words
The 13 packages (docs site excluded), each: what it's for / public surface / when a
user vs a contributor cares. Open with a two-column orientation table (package →
one-liner), then a `##` per package (~120–180 words), grouped in this order:
- **You'll use these:** `agents-sdk`, `frontend-sdk`, `cli`, `schema` (types/helpers),
  `reference-deployment` (copy-me starting point).
- **The platform:** `gateway`, `coordination`, `catalog`, `executor`,
  `harness-native`, `harness-casdk`.
- **Quality kits:** `conformance`, `chaos`.
Contributor-only packages say so in their first sentence. This page may go one level
deeper than Concepts (naming the outbox, reconciler, seams) — it's the sanctioned
machine-room tour; still no internal ids (the `work/` pointer on 5.1 covers history).
Sources: all 13 `packages/*/README.md` design notes (each README's first paragraph is
the seed; strip task ids), `packages/coordination/README.md` for the outbox/reconciler
story. Style-guide §9 stale-README list applies (schema/harness-native "PROPOSED",
conformance "not yet shipped", cli missing `keys`).

## Changelog — `content/changelog/` (T1.3-owned shell)
Entries follow the public voice; the seeded "v1" entry summarizes what ships today
(derived from `docs/README.md` + package READMEs, no ids). Future entries per release;
optional Changesets generation noted in the package README (not built).

## AI surface (T3.7 · W2 · plumbing, minimal content)
- Remap `nuxt-llms` sections in `nuxt.config.ts` to: Getting Started, Concepts, Guides,
  Reference, Contributing (llms.txt reflects our tree, not the template's).
- Verify MCP `list-pages`/`get-page` + `/raw/*.md` against the final tree.
- Delete `content/2.essentials/` and `content/3.ai/` (after T3.1/T3.2 land — G5).
- **No dedicated "AI tools" page.** Instead: one `::tip` in Getting Started →
  Introduction ("these docs are machine-readable: `/llms.txt`, raw markdown at
  `/raw/<path>.md`, and an MCP endpoint") — added by T3.7 as a one-block edit to
  1.getting-started/1.index.md (coordinate: T3.7 runs after T3.1, sequential groups,
  so no file conflict).
- Update `.env.example`/site URL, edit-this-page links → this repo.

---

## Comparison material — verdict on `differences-from-electric-agents.md`

**The public site gets a neutral architecture & design-rationale treatment, not a
comparison page. No page on the site mentions electric agents / electric.ax.**

- The KEEPS list becomes capability copy (landing, Introduction).
- The CHANGES table + planes diagram become `1.getting-started/4.architecture.md`
  (one-owner-per-concern, two planes, one-way projections) — stated as design
  principles with their own rationale, no "vs" framing.
- The DROPS list becomes the "design principles / what teaspill deliberately doesn't
  do" section of the same page (no platform permissions; single-tenant per deployment;
  control verbs, not signals; no stream-as-truth compaction) — each as a stance with a
  one-line why, accordion for depth.
- The "why a rebuild" war stories (upstream bug list) are **not published** — they're
  process history; the file relocates (below) and remains in git history.
Rationale: a public teardown of a niche upstream project ages badly, reads as axe-
grinding to newcomers who've never heard of either project, and adds zero utility to a
user deciding whether teaspill fits. The architecture content is what earns the page.

## Internal docs NOT migrated (and where they live post-cutover, per D3)

| Internal doc | Fate at cutover (owned by T4.1) |
|---|---|
| `docs/casdk-mapping.md` | **Not migrated** — frozen schema-freeze design artifact. Relocate to `work/plans/0001-build-v1/notes/casdk-mapping.md`; repoint the references in `packages/harness-casdk/README.md` and `docs/agents-sdk.md`-derived pages. |
| `docs/differences-from-electric-agents.md` | **Not migrated as such** (absorbed neutrally per the verdict above). Relocate original to `work/plans/0001-build-v1/notes/differences-from-electric-agents.md` as the positioning/history artifact. |
| `docs/self-hosting-networking.md` | **Absorbed** into Guides → Self-hosting (the rules + one accordion of rationale). The full container-networking rationale is contributor-grade: relocate original to `work/plans/0001-build-v1/notes/self-hosting-networking.md`; repoint the references in `packages/{executor,gateway,cli}/README.md`. |
| All other `docs/*.md` | **Migrated by rewrite** into the pages above, then deleted; `docs/README.md` becomes the stub (site pointer + `work/` pointer + "previous docs live in git history"). |

Coverage check (every internal doc accounted for): README→stub; addressing→2.3+4.2;
agents-sdk→3.1(+2.1/2.7); auth→3.4+4.3; backup-restore→3.5; casdk-mapping→relocated;
differences→1.4+relocated; frontend-sdk→3.2(+2.4/2.5); schema-reference→4.1(+2.4);
self-hosting-networking→3.3+relocated; self-hosting→3.3(+1.2/2.6/4.5); streams→2.4+4.1
(+retention knobs in 3.3/4.5).
