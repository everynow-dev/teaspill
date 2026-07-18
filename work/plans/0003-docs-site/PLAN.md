# 0003 — Public documentation site (`packages/docs`)

This plan delivers a public-facing documentation site for teaspill as a new workspace package, built on the official Nuxt UI docs template (Nuxt 4 + Nuxt UI v4 + Nuxt Content 3), with a custom "spilled tea" visual identity, a changelog section, and a full content rewrite of the existing `docs/` material into didactic, beginner-friendly pages for developers who have never heard of durable execution, Restate, or event-sourced timelines. At the end, the site becomes the single public documentation source and the repo's `docs/` folder is retired to a stub. This document is self-contained for its executors.

---

## 1. Background and motivation

teaspill has ~2,700 lines of internal documentation in `docs/` plus 12 package READMEs — accurate, but written by and for the people who built v1: it leans on plan/task/decision ids (`0001:T8.3`, `A6`), assumes fluency in Restate and event-sourcing vocabulary, and reads as an engineering ledger, not an on-ramp. A developer evaluating teaspill needs the opposite: a friendly site that teaches the concepts progressively, gets them to a running agent fast, and only then opens the machine room.

The site is modeled on the official Nuxt UI docs template and written in the style of the Nuxt and Laravel documentation. All template/reference research is pre-digested in `notes/template-research.md` — **read it before starting any task**; it contains the verified stack versions, template file structure, component inventory, and the concrete reference pages whose style we imitate.

## 2. Inherited constraints

- **Binding decisions:** `0001:D1–D8`, `0001:A1–A10` (`work/plans/0001-build-v1/DECISIONS.md`) plus any 0002 amendments. The docs *describe* these; nothing in this plan may contradict them. A content finding that appears to contradict a binding decision is a documentation bug or a real bug — check the code, and if the code disagrees with the decision, HALT + proposed amendment per protocol.
- **Repo hygiene:** `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint` green before any group commits. The docs package adds `build`/`generate` to that bar for its own groups (a docs site that doesn't build is not done). No live-infra requirement — the site is static.
- **Version pins:** root TypeScript 6.0.3 (`<6.1.0` cap) — the template wants `^6.0.3`, compatible. New pins introduced by this plan (Nuxt ^4.4.8, @nuxt/ui ^4.10.0, @nuxt/content ^3.15.0) are recorded in D1 (this plan's DECISIONS.md).
- **Plan-overlap rule (work/README.md):** plan 0002 is active in a parallel session. This plan is structured in **two waves** around it (see §4): Wave 1 (G1–G3) touches only `packages/docs/` + this plan's `notes/` and depends on nothing in flight in 0002 (its G1–G4 landings — addressing helpers, agents-sdk README, keys CLI, fast-join, backup regression — are already committed). Wave 2 (G4 onward) is blocked by **Gate 2** on 0002 landings: the reference deployment (`0002:T4.1`), live validation (`0002:T4.2`/`T4.3` — fix-anything license means runtime behavior may shift until they're green), and for the cutover, 0002 fully done including its docs sweep (`0002:T5.4`).
- **Conflict granularity for this plan:** the package-disjointness rule for parallel subagents is refined to **path-disjointness within `packages/docs`** — content tasks each own disjoint `content/` subdirectories and may run in parallel; two tasks touching the same file/config never share a group.

## 3. Task breakdown

Legend — **Model size**: S = mechanical, well-specified, low blast radius. M = standard implementation, local judgment. L = design-heavy, cross-cutting, high blast radius. **Critical** = failure blocks or corrupts other phases. Model per tier: dispatch profile in `work/README.md`.

**Standing rule for every content task (T3.x):** before writing a word, read (a) `notes/template-research.md` §3 and open the listed Nuxt/Laravel reference pages it names, (b) the style guide + IA produced by T2.1 (`notes/style-guide.md`, `notes/ia.md`), (c) the source material named in the task. Content is a **rewrite in the public voice, never a paste** of the internal docs. Verify every technical claim against the current code, not against the internal doc (the doc may lag 0002's changes).

**Public-voice rule (D4, absolute):** public pages must contain **zero** references to plan files, task/decision ids, `work/` paths, WORKLOG/DECISIONS, or internal doc filenames. Where the internal docs say "see 0001:A6", the public page either explains the point inline or tucks the fuller context into an expandable component (`::accordion`/`::collapse`-style prose component — T2.1 standardizes which) with a plain-language summary line. Grep-auditable in T4.2.

### Phase 1 — Scaffold, theme, changelog shell

**T1.1 — Scaffold `packages/docs` from the Nuxt UI docs template** · **M** · critical
Create the package from `nuxt-ui-templates/docs` (scaffold via `npm create nuxt@latest -- -t ui/docs` into a temp dir and move, or vendor the files — executor's choice, record in WORKLOG). Integrate into the pnpm workspace: name `@teaspill/docs`, private, scripts `dev`/`build`/`generate`/`typecheck` (vue-tsc); remove the template's own `packageManager` field (root pins pnpm); reconcile lint (template ships `@nuxt/eslint` flat config — either wire it into the root `eslint.config` as an override for `packages/docs` or exclude the package from root lint and keep its local lint in its own script; record the choice). Template content stays as-is in this task (placeholder); the AI-surface modules (`nuxt-llms`, MCP toolkit, raw-markdown routes) stay in. Definition of done: `pnpm --filter @teaspill/docs dev` serves the template locally, `generate` prerenders without env vars beyond defaults, and root-level `pnpm -r typecheck` / `pnpm -r test` / `pnpm lint` stay green.
*Anticipate:* pnpm build-script approvals — the root `pnpm-workspace.yaml` blocks unapproved postinstalls; the template pulls `@takumi-rs/core` (OG rendering, native) and Tailwind v4 oxide; extend `onlyBuiltDependencies` only for what actually breaks, with a comment, like the existing esbuild entry. Nuxt Content's `sqliteConnector: 'native'` uses `node:sqlite` — needs Node ≥22 at build time? Verify against the root `engines` (>=20.19.0) and either confirm it works on 20 or switch connector/document a Node 22 dev requirement in the package README. Root `vitest` runs `pnpm -r test` — the docs package has no tests; omit the script entirely (pnpm skips missing scripts) rather than adding a fake one.

**T1.2 — "Spilled tea" theme: colors, fonts, logo** · **M**
Make the template ours (D5). Direction (executor refines, records final values in WORKLOG): **primary** a warm spilled-tea amber/copper (Tailwind `amber`, or a custom `tea` scale in `main.css` via Tailwind v4 `@theme` if the stock ramp reads too yellow — aim for a steeped black-tea copper, not mustard); **neutral** `stone` (warm gray, paper-like light mode); **accent** matcha green available for success/info states. Dark mode leans dark-oolong (warm near-black), not blue-slate. Fonts via `@nuxt/fonts`: display/headings **Fraunces** (warm, slightly literary — fits the tea-house register), body a clean humanist sans (e.g. Inter or Public Sans), code JetBrains Mono. Replace `AppLogo.vue` with a simple teaspill wordmark + a minimal teacup/spill SVG mark (light/dark variants), favicon, and retint the OG-image template to the palette. Update `app.config.ts` colors + header/footer links (GitHub repo link, remove template-menu component).
*Anticipate:* Nuxt UI `ui.colors.primary` must name a Tailwind color — a custom scale needs the `@theme` CSS route; check WCAG contrast for amber-on-white (use 600/700 shades for interactive text on light backgrounds; the template's green default hides this class of problem). Keep the hero background components or restyle them — don't leave the template's stars motif if it fights the identity.

**T1.3 — Changelog section (content-driven)** · **M**
Per D2: no runtime GitHub fetch (the ungh/Comark approach in the changelog template — see `notes/template-research.md` §2). Instead: a `changelog` Nuxt Content collection (`content/changelog/*.md`, excluded from the docs sidebar collection) with frontmatter (title, date, description, optional image/badge), a `/changelog` page rendering entries newest-first via `UChangelogVersions`/`UChangelogVersion` + `ContentRenderer`, and a header nav link. Seed with one real entry: "v1" — a public-language summary of what the platform ships today (no task ids; derive the highlights from `docs/README.md` + package READMEs, written per the public-voice rule). Document the authoring flow in the package README; note (README + WORKLOG) the future option of generating entries from Changesets releases (`@changesets/cli` is already configured at the root) — out of scope to automate now.
*Anticipate:* keep the changelog collection out of `queryCollectionNavigation('docs')` and out of the docs search sections, or entries pollute the sidebar/⌘K; check `UChangelogVersion` slot/prop names against the installed @nuxt/ui version rather than the digest.

### Phase 2 — Information architecture & style guide (Gate 1)

**T2.1 — IA + writing style guide** · **L** · critical
The document every content agent obeys. Inputs: all reference pages in `notes/template-research.md` §3 (actually open and read the Nuxt and Laravel pages listed — the deliverable must cite what it borrows from each), the full existing `docs/` set, package READMEs, and the template's prose-component inventory (§1). Outputs, in `notes/`:
- **`style-guide.md`** — tone rules (didactic, confident, second-person, no fluff; Nuxt-style short pages with "read more" spokes for concepts, Laravel-style in-page progressive depth for task guides); page anatomy (opening promise sentence, when to use callouts, file-path-labeled code blocks, prev/next flow); the **terminology ramp**: the ordered list of terms a newcomer meets (durable execution → virtual object/single-writer → wake → timeline & canonical events → projection → catalog → workspace/executor → harness), where each is first defined, the plain-English definition to use, and the rule that no page uses a term the ramp hasn't introduced by that point (or it links to the definition); the **expandable-context pattern** implementing D4 (which prose component, how the summary line is written, worked example converting one real internal cross-reference); glossary page spec.
- **`ia.md`** — the complete page tree with filenames/ordering prefixes mapped to the template structure (`content/1.getting-started/…` etc.), and per page: outline, source material pointers (internal doc sections, package READMEs, code paths), target length, and which T3.x task owns it. Sections to cover (adapt, don't treat as final): Getting Started (introduction, installation, quick start, architecture overview) · Concepts (durable agents & the wake model, a Restate-for-newcomers primer, timelines & events, projections & the catalog, addressing, workspaces & execution, harnesses, multi-agent patterns, lifecycle & control verbs) · Guides (building agents, frontend/UI integration, self-hosting, auth & API keys, backup & restore) · Reference (event schema, addressing reference, CLI, configuration) · Contributing (the module/package breakdown — flagged as contributor-oriented where relevant) · Changelog. Decide what happens to comparison material (`differences-from-electric-agents.md`): the public site likely gets a neutral "architecture & design rationale" page, not a competitor teardown — IA decides and records.
Gate 1: main session reviews both artifacts before any Phase 3 dispatch.
*Anticipate:* the ramp is the heart of the didactic requirement — a newcomer must never hit "the outbox drains the projection" cold. Beginner-friendly ≠ verbose: the reference pages prove short + friendly is the target register. Also mark which internal docs are *not* migrated (candidates: `casdk-mapping.md` as a frozen design artifact) and where they live post-T4.1.

### Phase 3 — Content authoring

Phase 3 splits across the waves: **T3.2, T3.5, T3.6 are Wave 1** (they document frozen/landed surfaces: architecture decisions, schema v1, addressing, CLI, package structure). **T3.1, T3.3, T3.4, T3.7 are Wave 2** (they document runtime behavior and the getting-started path, which 0002's live-validation and reference-deployment work is still allowed to change).

**T3.1 — Landing + Getting Started** · **L** · critical · *Wave 2 (needs 0002:T4.1 + 0002:T4.2)*
`content/index.md` (hero/features/CTA in the site voice — the 30-second pitch: durable AI agents that survive restarts, spawn sub-agents, and stream everything to your UI) and `content/1.getting-started/`: **introduction** (what teaspill is, the problems it removes, for a dev who has never heard of Restate — the Nuxt introduction page is the model), **installation** (prereqs, the compose stack, `teaspill dev`, first successful boot), **quick start** (first agent end-to-end: define → register → send a message → watch the timeline in a browser; base it on the reference-deployment example from `0002:T4.1`, which Gate 2 guarantees has landed and passed live conformance), **architecture overview** (the two-planes + one-owner-per-concern picture from `docs/differences-from-electric-agents.md`, redrawn didactically and stripped of the comparison framing per T2.1's IA verdict).
*Anticipate:* the quick start is the single highest-value page and the most likely to rot — every command and code block must be actually runnable against the current repo; run them.

**T3.2 — Concepts section** · **L** · *Wave 1*
`content/2.concepts/` per the IA: the didactic core. Durable agents & the wake model; the Restate primer (what durable execution and virtual objects buy us, in plain language, linking out to restate.dev for depth); timelines & canonical events (`docs/schema-reference.md` as source, but taught, not specified); projections & the catalog (one-way flow, "streams are history, never control flow" — the D1 story without citing D1); addressing & naming (`docs/addressing.md`); workspaces & execution (`docs/self-hosting.md` §planes + executor README); harnesses (native vs Claude Agent SDK, when each); multi-agent patterns (spawn/send/observe, parent wakes); lifecycle & control verbs (interrupt/pause/resume/archive, resurrection).
*Anticipate:* this section is where the terminology ramp lives or dies — write pages in ramp order and respect it. Analogies help but must not lie; when simplifying, prefer "roughly:" + expandable precise version (the D4 pattern) over a false simple claim.

**T3.3 — Guides: building agents & frontend integration** · **M** · *Wave 2 (needs 0002:T4.2 green — live validation may adjust SDK/runtime behavior)*
`content/3.guides/` (its half per IA): building agents with `@teaspill/agents-sdk` (defineAgent, harness selection, platform/workspace tools, onWake contract, state revisions — sources: `docs/agents-sdk.md`, package README) and frontend/UI integration with `@teaspill/frontend-sdk` (timeline materialization, reducer, catalog shapes via Electric, actions client, React hooks; fast-join/snapshot offsets per `0002:T1.5`, landed — sources: `docs/frontend-sdk.md`, `docs/streams.md` reader parts). Laravel-style task pages: claim → runnable code → variations.

**T3.4 — Guides: operations** · **M** · *Wave 2 (needs 0002:T4.1 — the compose overlay is part of the self-hosting story)*
Self-hosting (compose stack incl. the `0002:T4.1` overlay, env config, networking stance from `docs/self-hosting-networking.md` distilled to the rules an operator needs), auth & API keys (`docs/auth.md` + the `teaspill keys` CLI from `0002:T5.1`, landed), backup & restore (`docs/backup-restore.md` — including the restore matrix taught as "what combinations restore cleanly", public voice).

**T3.5 — Reference section** · **M** · *Wave 1 (schema v1 frozen; addressing settled by 0002:T1.4; keys CLI landed)*
`content/4.reference/` per IA: event schema reference (from `docs/schema-reference.md` — this one stays close to a spec, that's its job; still public-voice), addressing reference (the tables/grammars from `docs/addressing.md`), CLI reference (`packages/cli` — every command, flags, examples), configuration/env reference (compose env vars, gateway config — sources: `docs/self-hosting.md`, gateway README).

**T3.6 — Contributing: the module breakdown** · **M** · *Wave 1*
`content/5.contributing/` (or per IA): the package-by-package map — for each of the 13 packages: what it is for, its public surface, when a user vs a contributor cares. Where a page is mostly contributor-facing, say so up front ("You only need this if you're working on teaspill itself"). Sources: package READMEs (each has a design note). Also: how to run the repo (pnpm workspace, typecheck/test/lint bar), where design history lives (this page MAY link to `work/` — it's the one sanctioned exception to D4, aimed at contributors, and T2.1 writes the exact wording rule).

**T3.7 — AI surface & site plumbing for our content** · **M** · *Wave 2 (needs the full page tree, incl. T3.1)*
Reconfigure the template's AI/LLM surface for the real content: `nuxt-llms` section mapping in `nuxt.config.ts` (llms.txt reflects our sections, not the template's), verify the MCP `list-pages`/`get-page` tools and `/raw/*.md` routes against the final page tree, delete the template's `content/2.essentials/` + `3.ai/` placeholder content once real sections exist (coordinate: runs in the group *after* T3.1/T3.2 land so navigation never goes empty), update `.env.example`/site URL config, edit-this-page links point at this repo.

### Phase 4 — Consolidation (Gate 3)

**T4.1 — Retire `docs/`: migration cutover** · **M** · *Wave 2 (needs plan 0002 fully DONE, incl. 0002:T5.4)*
Per D3, after all Phase 3 content is merged and building: delete the migrated `docs/*.md` files; replace `docs/README.md` with a stub pointing to the site (`packages/docs`, dev command, deployed URL when known) and, for design history, to `work/` ledgers + package READMEs; relocate any not-migrated internal artifacts per T2.1's list (e.g. `casdk-mapping.md` → `work/plans/0001-build-v1/notes/` or a package doc — IA's call); sweep the whole repo for now-dangling `docs/*.md` references (package READMEs, code comments, CLAUDE/AGENTS.md, `work/` templates) and repoint them. Precondition (R1): `work/INDEX.md` shows 0002 `done` — its T5.4 sweep ran against the old `docs/`, and any factual corrections it made must be absorbed into the site pages before deletion (diff `docs/` against the git revision the Wave-2 content agents read).
*Anticipate:* git history keeps the old files — the stub should say that ("previous docs live in git history and work/ ledgers"). AI-agent context loss is the accepted cost per D3; the mitigation is the stub's pointer to `work/`, not keeping parallel docs.

**T4.2 — QA: fresh-eyes review, audits, build** · **L** · critical (gate)
The acceptance pass. (a) **Fresh-eyes read-through**: an agent with *no teaspill context beyond the site itself* reads the whole site in nav order and reports every point of confusion, undefined term, broken ramp, or unrunnable snippet; findings fixed or ticketed in WORKLOG. (b) **Public-voice audit**: grep the built content for the D4 ban list (task/decision id patterns like `T\d+\.\d+`, `0001:`/`0002:`/`0003:`, `WORKLOG`, `DECISIONS`, `work/plans`, internal doc filenames) — zero hits outside the sanctioned contributing exception. (c) **Mechanical audits**: internal link check across pages + nav, `generate` green, search returns sensible results, changelog renders, dark/light contrast spot-check, mobile sidebar. (d) Code snippets in the quick start and guides re-verified runnable. Gate 3: this task green (and T4.1's sweep clean) closes the plan's build phase.

**T4.3 — Deployment & CI wiring** · **S/M**
Add the docs package to CI (lint/typecheck/`generate` on the same workflow that runs the repo checks); verify static output (`.output/public`) deploys cleanly; document deployment options in the package README (static hosting/Vercel per the template's support; `NUXT_PUBLIC_SITE_URL` for OG images). Actual hosting/domain choice is the user's — present options in the WORKLOG entry, don't provision anything external.

## 4. Sequencing & gates

```
WAVE 1 (parallel-safe with 0002, runs now):
T1.1 ──► { T1.2 · T1.3 · T2.1 } ──Gate 1──► { T3.2 · T3.5 · T3.6 }
                                                      │
                                            ══ Gate 2: WAIT for 0002 ══
                                            (0002:T4.1 landed, 0002:T4.2 green
                                             → dispatch G4; 0002 fully done
                                             → dispatch G5+; plan pauses here
                                             if 0002 hasn't caught up)
WAVE 2:                                               │
                              { T3.1 · T3.3 · T3.4 } ──► T3.7 ──► { T4.1 · T4.3 } ──► T4.2 (Gate 3)
```

Hard gates:
1. **Gate 1:** T2.1's style guide + IA reviewed by the main session before any T3.x dispatch. Content written without the ramp/IA gets rewritten — don't pipeline.
2. **Gate 2 (cross-plan wait):** Wave 2 content (G4) needs `0002:T4.1` (reference deployment — the quick-start/self-hosting substrate) landed AND `0002:T4.2` live conformance green (its fix-anything license means runtime behavior isn't stable before that). The cutover group (G6) additionally needs 0002 `done` in `work/INDEX.md`. When Wave 1 finishes before 0002 gets there: flip this plan to `paused` in INDEX with the resume pointer stating exactly which 0002 milestones it's waiting on — do NOT start Wave 2 content early against a moving target.
3. **Gate 3:** T4.2 fully green closes the plan. `docs/` deletion (T4.1) only after all Phase 3 merged + site building.

Risks (standing):
- **R1 — 0002 overlap:** resolved structurally by Gate 2 — Wave 1 touches only `packages/docs/` + this plan's `notes/`; everything that reads 0002-affected surfaces or touches `docs/` waits for the corresponding 0002 milestone. Residual: Wave 1 concept/reference pages still describe the frozen architecture — if 0002's live validation forces an amendment to a binding decision (HALT territory over there), re-check affected Wave 1 pages at T4.2.
- **R2 — didactic vs correct:** simplification must never produce a false claim; use the "roughly + expandable precise version" pattern (D4/T2.1).
- **R3 — template drift:** the digest in `notes/template-research.md` was verified 2026-07-18; if scaffolding pulls newer versions with breaking changes, pin to the digest's versions and record.

## 5. Task/model-size summary

| Task | Title | Size | Wave | Critical |
|---|---|---|---|---|
| T1.1 | Scaffold packages/docs from template | M | 1 | ✔ |
| T1.2 | "Spilled tea" theme (colors, fonts, logo) | M | 1 | |
| T1.3 | Changelog section (content-driven) | M | 1 | |
| T2.1 | IA + writing style guide | L | 1 | ✔ (Gate 1) |
| T3.1 | Landing + Getting Started | L | 2 | ✔ |
| T3.2 | Concepts section | L | 1 | |
| T3.3 | Guides: agents & frontend | M | 2 | |
| T3.4 | Guides: operations | M | 2 | |
| T3.5 | Reference section | M | 1 | |
| T3.6 | Contributing: module breakdown | M | 1 | |
| T3.7 | AI surface & plumbing for our content | M | 2 | |
| T4.1 | Retire docs/ (migration cutover) | M | 2 | |
| T4.2 | QA: fresh-eyes, audits, build | L | 2 | ✔ (Gate 3) |
| T4.3 | Deployment & CI wiring | S/M | 2 | |

## 6. Orchestration

Executed by a main coordinating session dispatching one subagent per task. Protocol: `work/README.md` (ledger discipline, scoped references, plan-overlap rule). Kickoff for a fresh session: **"Read work/plans/0003-docs-site/PLAN.md and start work."**

Per-plan specifics:

- Every subagent receives: this document; its task id; this plan's DECISIONS.md + WORKLOG.md; `notes/template-research.md`; and (for T3.x) `notes/style-guide.md` + `notes/ia.md` + its named source material.
- Content agents (T3.x) must actually open the external reference pages named in `notes/template-research.md` §3 before writing — style adherence is checked at Gate 3, not assumed.
- Conflict rule refined for this plan: path-disjointness within `packages/docs` (see §2). Config files (`nuxt.config.ts`, `app.config.ts`, `content.config.ts`) count as single paths — only one in-flight task may own each.
- Subagents return their WORKLOG entries; the main session merges, reviews (including a taste check against the style guide for content tasks), and commits each group atomically with ledger updates.
- Definition of done: pages/code merged + `pnpm --filter @teaspill/docs generate` green + root checks green + WORKLOG entry. L tasks leave their design notes in `notes/` (T2.1) or the package README (T1.1).

### Dispatch groups (≤3 parallel; groups strictly sequential)

| Group | Wave | Parallel tasks | Rationale / dependencies satisfied |
|---|---|---|---|
| G1 | 1 | T1.1 | Scaffold solo — everything depends on the package existing and building. |
| G2 | 1 | T1.2 · T1.3 · T2.1 | Theme (app/ + config) ∥ changelog (own pages/collection) ∥ IA/style (notes/ only) — path-disjoint. **Gate 1 review closes this group.** |
| G3 | 1 | T3.2 · T3.5 · T3.6 | Wave-1 content: concepts ∥ reference ∥ contributing — disjoint content dirs, all documenting frozen/landed surfaces. **Wave 1 ends here; Gate 2 wait.** |
| G4 | 2 | T3.1 · T3.3 · T3.4 | Wave-2 content after 0002:T4.1 + T4.2: getting-started ∥ agents/frontend guides ∥ ops guides — disjoint content dirs. |
| G5 | 2 | T3.7 | AI-surface/plumbing + template-placeholder cleanup solo (edits nuxt.config + deletes template content; needs the full page tree). |
| G6 | 2 | T4.1 · T4.3 | Cutover sweep (repo-wide, mostly outside packages/docs; needs 0002 done) ∥ CI/deploy wiring — disjoint. |
| G7 | 2 | T4.2 | Acceptance QA solo with fix-anything license inside packages/docs. **Gate 3.** |
