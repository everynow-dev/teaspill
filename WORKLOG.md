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
- None blocking. Web access availability for T2.0 (Restate docs) to be checked when G2 dispatches.
