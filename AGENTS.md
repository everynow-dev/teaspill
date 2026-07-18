# AGENTS.md — teaspill agent/contributor guide

Shared guidance for AI agents and contributors working in this repo. `CLAUDE.md` is a symlink to this file.

## Commits

- **Do NOT add Claude / any AI as a commit co-author.** No `Co-Authored-By:` trailer for AI. Commits are authored plainly.
- Use conventional-commit style subjects (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Commit or push only when asked. Never force-push a shared branch.

## Orchestration (see work/README.md)

- All project management lives under `work/`: one directory per plan (`work/plans/NNNN-<slug>/` with its own PLAN.md, DECISIONS.md, WORKLOG.md), a registry in `work/INDEX.md` (which plans are active), templates in `work/templates/`. Start there.
- Work is driven by a main coordinating session dispatching subagents per the active plan's dispatch groups. Currently active: `work/plans/0002-follow-ups/`, `work/plans/0003-docs-site/`.
- Ledgers are the resume mechanism: the plan's `WORKLOG.md` (findings, one entry per task + a RESUME POINTER at the top) and `DECISIONS.md`. Read both before continuing.
- Task/decision ids are plan-scoped; outside a plan's own directory, qualify them (`0001:T2.2`, `0002:T2.1`).
- Architectural decisions from completed plans stay binding (`0001:D1–D8`, `0001:A1–A10` in `work/plans/0001-build-v1/DECISIONS.md`).
- Each dispatch group is committed atomically together with its ledger updates, so `git log` + the resume pointer always agree on where work stands.
- Parallel subagents must NOT write the ledgers directly (append races) — they return their entries and the main session commits them.
- Assign a model to each task by its S/M/L tier via the dispatch profile in `work/README.md` (vendor-neutral tiers; the tier→model binding lives in one editable place).

## Build / test

- pnpm workspace, TypeScript (pinned `<6.1.0` — typescript-eslint peer cap), ESM, Node 20+.
- `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint` must be green before a group is committed.
- Tests that need live infra (Restate server, durable-streams, Postgres) must skip-guard when the service/env is absent, so CI stays green without the stack.
