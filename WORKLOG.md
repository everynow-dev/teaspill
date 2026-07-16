# teaspill — Worklog

Append-only findings ledger. One entry per completed task: what was built, deviations, surprises, open questions. Read before starting dependent work.

---

## ▶ RESUME POINTER (main session — update after every group)

- **Completed & committed:** 8.0 self-init, G1 (T0.3, T0.4, T0.2), G2 (T0.1+T3.1, T2.0, T1.1).
- **NEXT GROUP: G3** — schema freeze review (main session, Gate 1) · T1.3 catalog schema · T2.4 cron.
- **Gates status:** Gate 1 (T0.1 freeze) PENDING — do in G3, review `docs/casdk-mapping.md` first. Gate 2 (T2.0) ✅ PASSED. Gate 4 (T0.4 license) ✅ PROCEED.
- **Open D-amendment proposals awaiting no one (already accepted):** A1, A2, A3, A4 (all non-contradictory refinements). No thread is HALTED.
- **To continue in a fresh session:** read PLAN.md §8 + this pointer + `git log --oneline`, then dispatch the NEXT GROUP. Model map: L→Fable, M→Opus, S→Sonnet.

---

## Main session — 8.0 self-initialization (2026-07-16)

- Confirmed working dir is `teaspill/` with PLAN.md; was NOT a git repo → ran `git init`.
- Created `DECISIONS.md` (D1–D8 + `name: teaspill`), this `WORKLOG.md`, and `references/`.
- `../electric` sibling **present**. Confirmed the CASDK spike lives in the working tree:
  `git -C ../electric status --porcelain` shows added `CLAUDE_AGENT_SDK_PLAN.md` and a new
  `packages/agents-runtime/src/claude/` dir (claude-adapter, session-store, repair, precompaction,
  history-policy, messages, usage, tools, SESSION_FORMAT.md, etc.) plus modified pi-adapter/types/context-factory.
  So T7.0 has full raw material. Not modifying anything under `../electric`.
- **Model dispatch mapping (per Andrés, overrides §8.3 default):** L → Fable (`fable`), M → Opus (`opus`), S → Sonnet (`sonnet`). Subagent `model` param set accordingly.

### Open questions / degradations
- None blocking. Web access availability for T2.0 (Restate docs) to be checked when G2 dispatches — confirmed WORKING in G1 (T0.4 fetched live).

---

## G1 (2026-07-17)

### T0.3 — Repo scaffold
Built pnpm workspace: 9 packages under `packages/*` per PLAN §5, each with package.json (`@teaspill/<pkg>`), tsconfig.json + tsconfig.build.json (tsc-only, no bundler), vitest.config.ts, src/index.ts + src/index.test.ts. Root: strict tsconfig.base.json, ESLint flat config + Prettier, Vitest, Changesets (all packages private), `.github/workflows/ci.yml` (install→lint→typecheck→test). CLI package has `bin: teaspill` + shebang. Pinned typescript@6.0.3 (NOT 7.0.2 — typescript-eslint@8.64 caps TS <6.1.0; see DECISIONS tooling note). Verified for real: install, typecheck, test, build, lint, format:check all green (9/9 pkgs, 10 tests). Fixed two real bugs while verifying: (1) root vitest `projects` glob broke per-package `vitest run` → gave each package its own vitest.config.ts; (2) tsc emitted *.test.ts into dist/ → double-run → split build tsconfig to exclude tests. 66 files. No commit (main committed). Deviation: none. DECISIONS amendment: none (tooling note only).

### T0.4 — License verification (gate)
Checked Restate server (BSL 1.1 → Apache-2.0 in 4yr/release; Additional Use Grant permits self-host, bars only multi-tenant "Public Restate Platform Service"), Restate TS SDK (MIT), durable-streams client (MIT — PLAN guessed Apache, corrected) + Rust server (Apache-2.0). Web access worked fully. **R1 verdict: PROCEED**, no DBOS/Temporal fallback needed. Standing constraint recorded in DECISIONS: don't ever expose raw Restate registration to third-party devs in a multi-tenant hosted mode. Full detail in DECISIONS "License verification (T0.4)".

### T0.2 — Addressing & naming model (docs/addressing.md)
Scheme: entity url `/t/<tenant>/a/<type>/<id>` = `entities.url` pk = entityId everywhere; gateway short form `/a/<type>/<id>` expands to default tenant. Segments `^[a-z0-9][a-z0-9_-]*$` (tenant≤32/type≤48/id≤64). Instance id = lowercase ULID (time-sortable); caller-supplied ids allowed for deterministic/idempotent spawn (Restate get-or-create arbitrates; re-spawn = no-op reattach). Streams: timeline `/t/<tenant>/agents/<type>/<id>/timeline`, sibling `/deltas` (name reserved, framing TBD by T0.1/T5.1), workspace stdout `/t/<tenant>/workspaces/<name>/stdout`. Workspace key `<tenant>/<name>` (private default `a-<type>-<id>`). Restate: agent svc `agent.<type>` key `<id>`; `steer` key = full entity url; `workspace` key = `<tenant>/<name>`; `cron` key = `<name>`. **durable-streams constraints** (read from `../electric` durable-streams-rust source; root PROTOCOL.md absent in checkout): C1 stream name = HTTP path verbatim, slashes fine; C2 on-disk path encode keeps `[A-Za-z0-9._-]`, others→`+`, trunc120+`~id` — our charset stays clean; C3 must PUT-create before POST-append (404 else); **C4 idempotent producer = (Producer-Id, Epoch, Seq), Seq MUST start 0 gapless +1** → Producer-Id=entity url, Seq=canonical seq. Electric `where` = scalar-column equality with positional params → recommend `entities.tenant` column + normalized `entity_tags` (jsonb where awkward). Reference TS derivation fns embedded in doc, destined for `packages/schema`. → DECISIONS A1 (seq 0-based gapless, binds T0.1), A2 (entities.tenant + entity_tags → T1.3), A3 (Restate service naming → confirm T2.0).

## G2 (2026-07-17)

### T0.1 + T3.1 (+T7.1 paper-mapping) — Canonical event schema · Harness interface · CASDK mapping — **PROPOSED, NOT FROZEN** (G3 freezes)
Envelope `{ v:1, entityId, seq, ts, type, payload }`; seq 0-based gapless per A1 (harnesses emit `TimelineEventInit` WITHOUT seq; the outbox's `finalizeEvent` is the ONLY seq allocator — that split enforces A1). 15 types incl. `opaque {origin, kind, data}` (lossless foreign round-trip, deep-equal tested). `entity_spawned` always seq 0. **Delta framing = sibling `/deltas` stream** (NOT interleaved): the idempotent producer (A1/C4) can't host droppable records (a dropped fake-seq = rejected gap); deltas have no seq, `ref`→finalized event id, `idx` gaps legal, finalized event always wins on dedup, `attempt` field for T7.4 retry dedup. **Snapshot↔seq:** snapshot at seq N = state after consuming seq ≤ N (inclusive); fast-join = init from payload then consume N+1… (`checkSeqContiguity`). `archived` is episode-terminal only (resurrection continues seq). **Harness:** `run({entityId, runId, canonicalContext, wakeMessage, tools, steerSource, signal, emitDelta, commitEvents?}) → {events, stateDelta, usage}`; tool clients in `ToolContext` pre-bound to idempotency key `(entityUrl, runId, toolUseId)` via `toolIdempotencyKey`; `emitDelta` fire-and-forget invariant tested. `selectContextEvents` = summarization fold (latest wins) + context filter; `reasoning` never re-enters context. **Biggest CASDK tension:** thinking signatures are unforgeable → canonical `reasoning` cannot round-trip into a rebuilt session — resolved as deliberate display-only asymmetry (warm path unaffected), NOT via `opaque`. Naming: chose `control` event type (not PLAN's `signal`) per D8 dropped-POSIX vocab. Tests: schema 49 + harness-native 15 passed; repo lint/build/typecheck green. **G3-freeze-review items** (in casdk-mapping.md §8): (a) `control` vs `signal` name; (b) `summarization.detail` added; (c) `ContentBlock`=text+image only (future CASDK `document`→opaque); (d) `tool_result.detail` populated by in-process tool layer not stream capture (note for T7.2). Deviation: accidentally prettier-reflowed docs/self-hosting-networking.md (T1.1's untracked file; content identical). DECISIONS amendment: none.

### T2.0 — Restate semantics spike (Gate 2) — **PASSED**, code-verified (Restate 1.7.2 + TS SDK 1.16.2 in docker). Full detail in `SPIKE-RESTATE.md`.
(a) Shared handlers run concurrently with a busy exclusive handler, see mid-run K/V, and can `ctx.cancel` the in-flight wake → **interrupt/signal CAN reach a busy agent object**. But default cancellation zombies the closure + post-cancel awaits rethrow → must set `explicitCancellation:true` + race `ctx.cancellation()` + AbortController (~20ms abort). API is `@experimental` → pin SDK, conformance-test. (b) `ctx.run` results OK to 16MiB (warn ≥10MiB); ≥32MiB wedges invocation at replay; ingress cap 32MiB. Budget journal ≤~1MiB; bulk→streams (R4). (c) Idempotency-key dedups calls+sends, default retention 24h (tunable), expiry LAZY → treat retention as a floor. (d) Awakeables: `orTimeout`→catchable TimeoutError, survive endpoint restart, double/late resolve ignored. (e) Completed `ctx.run` never re-executes on replay; aborted-mid-flight re-executes from scratch (at-least-once) and zombie closures overlap retries → per-handler timeouts + `AbortSignal.any([interrupt, attemptCompletedSignal])`. (f) **A3 CONFIRMED**: `agent.<type>` accepted; keys arbitrary strings incl. url/slashes (percent-encode in ingress; reject empty key at gateway). → proposes **A4**.

### T1.1 — Compose stack
5 services on one `teaspill` network: postgres, restate, electric, durable-streams, gateway (build stub; T1.2 fills Dockerfile). Healthchecks + `restart:unless-stopped` on all EXCEPT durable-streams — **surprise: its published image `electricax/durable-streams-server-rust:0.1.4` is distroless (no shell/curl/CLI healthcheck), verified by pulling+listing fs** → healthcheck disabled, `depends_on: condition: service_started`, documented in `docs/self-hosting-networking.md §5`. Tags pinned & live-verified 2026-07-17 (pull+inspect): `restatedev/restate:1.7.2`, `postgres:17-alpine`, `electricsql/electric:1.7.7` (ships own /v1/health), `electricax/durable-streams-server-rust:0.1.4`. Postgres `wal_level=logical`, `listen_addresses=*`; Electric auto-creates publication/slot (T1.3 still owns the `entities`-table publication). **Networking stance documented** (`docs/self-hosting-networking.md`): host-run services register via `host.docker.internal`, NOT `localhost` (Restate dials deployment URLs directly — the electric loopback class); added `extra_hosts: host-gateway` to restate. `docker compose config` validated clean. Open: when T2.2 adds the durable-streams client dep, pin it to match server 0.1.4's protocol, not client-latest. DECISIONS amendment: none.
