# work/ — project-management area

All planning and execution-tracking files live here, scoped per plan, so numbered references (task ids, decision amendments) never collide across initiatives and the repo root stays clean.

## Layout

```
work/
  README.md            # this process guide
  INDEX.md             # registry of all plans + status (the at-a-glance state)
  templates/           # skeletons for starting a new plan
    PLAN.md  DECISIONS.md  WORKLOG.md
  plans/
    NNNN-<slug>/       # one directory per plan, never renamed or moved
      PLAN.md          # the plan: background, tasks, sizing, gates, dispatch groups
      DECISIONS.md     # decisions made/amended during THIS plan
      WORKLOG.md       # findings ledger + RESUME POINTER for this plan
      notes/           # digests, spike results, scratch docs for this plan
```

Research docs and spike digests belong in the plan's own `notes/` — never in a shared top-level dir. A closed plan's directory never moves (see Archive below), so `notes/` content stays put and reachable forever; a shared dir has no such anchor and drifts. `docs/` (published, outlives any plan) is the one exception that stays outside `work/`.

Repos an agent self-clones for a spike (e.g. `../electric`, a Restate SDK checkout) go in the top-level `references/` dir, gitignored — throwaway, never committed. Whatever the clone teaches you gets distilled into the plan's `notes/`, not left in the clone.

## Plan lifecycle

1. **Open:** copy `templates/*` into `plans/NNNN-<slug>/` (next free 4-digit id, kebab slug), fill in PLAN.md, add a row to `INDEX.md` with status `active`.
2. **Work:** execute per the plan's own orchestration section. Ledger discipline (below) is what makes any session interruptible/resumable.
3. **Pause:** flip INDEX status to `paused`; the plan's WORKLOG resume pointer must say exactly where it stopped and what to dispatch next.
4. **Archive:** flip INDEX status to `done` (or `abandoned`), write a closing entry in the plan's WORKLOG. **Directories never move** — archival is a status flip, so every cross-reference and git-history link stays valid forever. "Which plans are live" is always answered by `INDEX.md`, not by directory location.

Multiple plans may be `active` in parallel. Constraint: two plans must not have *in-flight* tasks touching the same package at the same time — the same file-conflict rule that governs parallel subagents within a plan, lifted to plan level. Check the other active plans' resume pointers before dispatching.

## Reference letters (fixed across ALL plans)

Each category of numbered reference has ONE letter, the same in every plan. Disambiguation between plans comes from the plan-id prefix (below), never from changing the letter. Do not invent new letters or reuse a letter for a different category.

| Letter | Category | Meaning |
|---|---|---|
| **T** | Task | A unit of dispatched work (`T2.2`). Numbered `T<phase>.<n>`. |
| **G** | Group | A dispatch group — ≤3 parallel tasks, groups run strictly sequential (`G4`). |
| **D** | Decision | An architectural decision. Binds the codebase, outlives its plan. |
| **A** | Amendment | A revision or addition to the decisions, made during the plan (`A9`). |
| **R** | Risk | A cross-cutting risk to watch throughout the plan (`R1`). |
| **Gate N** | Gate | A hard checkpoint that blocks its dependents until passed (`Gate 3`). |
| **Phase N** | Phase | A theme grouping of tasks within a plan (`Phase 2`). |

A plan need not use every letter, but whatever it uses must match this table. Numbering restarts per plan (both `0001` and `0002` have a `T2.1`); the plan id keeps them apart.

## Scoped references

- **Inside a plan's own files:** bare ids — `T2.2`, `A3`, `G5`, `Gate 3`. They resolve to that plan.
- **Anywhere else** (other plans, commit messages, code comments, docs, source): qualify with the plan id — `0001:T2.2`, `0001:A9`, `0002:T2.1`, `0001:Gate 3`. Never write a bare task/decision/amendment/group id outside its own plan directory; it goes stale or ambiguous the moment a second plan exists.

## Decisions inheritance

Architectural decisions bind the *codebase*, not the plan that produced them. `0001:D1–D8` and `0001:A1–A10` remain in force even though plan 0001 is done. A new plan's DECISIONS.md starts by *pointing* at what it inherits (never copying it) and appends only its own amendments. Superseding an inherited decision requires an explicit amendment in the new plan naming the qualified id it supersedes.

## Ledger discipline (applies to every plan)

- `WORKLOG.md` is append-only, one entry per completed task, with a **RESUME POINTER at the top** updated after every dispatch group.
- Each dispatch group is committed atomically together with its ledger updates, so `git log` + the resume pointer always agree.
- Parallel subagents never write the ledgers directly (append races) — they return their entries; the main session merges and commits.
- A finding that contradicts a binding decision ⇒ subagent writes a proposed amendment to the plan's DECISIONS.md and halts that thread until resolved.
- Assign a model to each task by its S/M/L tier via the **dispatch profile** below.

## Model sizing & dispatch profile

**S/M/L describe the task, not any model** — they are intrinsic and vendor-neutral. Plans state a tier per task and never name a model:

| Tier | What the task demands |
|---|---|
| **S** | Mechanical, fully specified, low blast radius. A fast/cheap model; little judgment. |
| **M** | Standard implementation needing local judgment. A solid mid-tier model + the relevant plan section. |
| **L** | Design-heavy, cross-cutting, high blast radius. The strongest available reasoning model, long context, and standing permission to halt-and-escalate when reality contradicts a decision. |

Binding a tier to a concrete model is a **separate, swappable choice** — the dispatch profile. Change it to run the same plans on any model family; nothing else needs editing.

**Current profile** (edit these three rows for your run):

| Tier | Model |
|---|---|
| L | Claude Fable |
| M | Claude Opus |
| S | Claude Sonnet |

- Any capable family works — slot its strongest→cheapest tiers into L/M/S (e.g. a GPT/Gemini/OSS lineup).
- A plan may override the profile for its own run in that plan's WORKLOG resume pointer.
- A model dispatched **without** a profile should self-map S/M/L onto its own strongest→cheapest tiers using the task table above.
