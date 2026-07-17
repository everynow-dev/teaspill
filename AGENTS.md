# AGENTS.md — teaspill agent/contributor guide

Shared guidance for AI agents and contributors working in this repo. `CLAUDE.md` is a symlink to this file.

## Commits

- **Do NOT add Claude / any AI as a commit co-author.** No `Co-Authored-By:` trailer for AI. Commits are authored plainly.
- Use conventional-commit style subjects (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Commit or push only when asked. Never force-push a shared branch.

## Orchestration (see PLAN.md §8)

- This build is driven by a main coordinating session dispatching subagents per PLAN.md's dispatch groups G1→G13.
- Ledgers are the resume mechanism: `WORKLOG.md` (findings, one entry per task + a RESUME POINTER at the top), `DECISIONS.md` (D1–D8 + amendments A1…). Read both before continuing.
- Each dispatch group is committed atomically together with its ledger updates, so `git log` + the WORKLOG resume pointer always agree on where work stands.
- Parallel subagents must NOT write `WORKLOG.md`/`DECISIONS.md` directly (append races) — they return their entries and the main session commits them.
- Model dispatch mapping: **L → Fable, M → Opus, S → Sonnet**.

## Build / test

- pnpm workspace, TypeScript (pinned `<6.1.0` — typescript-eslint peer cap), ESM, Node 20+.
- `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint` must be green before a group is committed.
- Tests that need live infra (Restate server, durable-streams, Postgres) must skip-guard when the service/env is absent, so CI stays green without the stack.
