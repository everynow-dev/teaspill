# <NNNN> — <Title>

One-paragraph statement of what this plan delivers and why now. This document is self-contained for its executors: background, inherited constraints, full task breakdown with anticipation notes, model-size ratings, and the orchestration protocol.

---

## 1. Background and motivation

Why this work exists. Link the plans/decisions it builds on with qualified ids (`0001:A9`).

## 2. Inherited constraints

- Binding decisions inherited from prior plans (point, don't copy): e.g. `0001:D1–D8`, `0001:A1–A10`.
- Frozen surfaces this plan must not break (additive-only rules, etc.).
- If a task uncovers evidence against an inherited decision: stop, propose an amendment in this plan's DECISIONS.md, halt the thread.

## 3. Task breakdown

Legend — **Model size**: S = mechanical, well-specified, low blast radius. M = standard implementation, local judgment. L = design-heavy, cross-cutting, high blast radius. **Critical** = failure blocks or corrupts other phases. Model per tier: dispatch profile in `work/README.md` (vendor-neutral). Reference letters (T/G/D/A/R/Gate/Phase) are fixed across all plans — see `work/README.md`.

### Phase 1 — <name>

**T1.1 — <Title>** · **S/M/L** · critical?
What to build. Where it lives. Definition of done.
*Anticipate:* known traps, seams, things to verify before relying on them.

## 4. Sequencing & gates

Dependency sketch + hard gates (a group containing a gate never overlaps its dependents).

## 5. Task/model-size summary

| Task | Title | Size | Critical |
|---|---|---|---|

## 6. Orchestration

Executed by a main coordinating session dispatching one subagent per task. Protocol: see `work/README.md` (ledger discipline, scoped references, conflict rules). Per-plan specifics:

- Every subagent receives: this document, its task id, this plan's DECISIONS.md + WORKLOG.md, and (if relevant) pointers into prior plans' ledgers.
- Definition of done: code + passing tests in CI + returned WORKLOG entry. L tasks also leave a design note in the package README.
- Integration review between groups; never pipeline groups. ≤3 parallel subagents per group; same-group tasks touch disjoint packages.

### Dispatch groups

| Group | Parallel tasks | Rationale / dependencies satisfied |
|---|---|---|
