# teaspill — Worklog

Append-only findings ledger. One entry per completed task: what was built, deviations, surprises, open questions. Read before starting dependent work.

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
