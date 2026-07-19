# 0003 — Worklog

Append-only findings ledger. One entry per completed task: what was built, deviations, surprises, open questions. Read before starting dependent work.

---

## ▶ RESUME POINTER (main session — update after every group)

- **Status:** ▶ **ACTIVE — G6 partial: T4.3 done + committed; T4.1 HELD; T4.2 (G7 fresh-eyes) in flight.** G1–G5 + T4.3 landed.
- **⛔ T4.1 (docs/ cutover) BLOCKED — do NOT run until 0002 is verifiably done.** R1 precondition = `work/INDEX.md` shows 0002 `done`. On disk 2026-07-19: INDEX shows 0002 `active`; 0002's WORKLOG pointer says "G5 done, next **G6**" with **T5.4 (its docs/ sweep) NOT yet run**; T3.1 observed the dev stack running from a live 0002 session. User stated "0002 fully done" but the on-disk evidence contradicts it. **Deleting `docs/*.md` now would destroy the files 0002:T5.4 must sweep** — a real cross-plan conflict, and hard to reverse. **Surfaced to user; awaiting confirmation** that (a) 0002 is truly done / INDEX flipped, and (b) no parallel session is mid-edit of `docs/`. When confirmed: run T4.1 = migrate/delete `docs/*.md`→stub, relocate `casdk-mapping.md`/`differences-from-electric-agents.md`/`self-hosting-networking.md` → `work/plans/0001-build-v1/notes/`, repo-wide dangling-`docs/`-ref sweep, **diff `docs/` vs baseline `c98d504`** to absorb 0002:T5.4 fixes, and fix the stale SOURCE files listed below.
- **NEXT after T4.2 returns:** review fresh-eyes findings, run the mechanical audits (public-voice grep [done clean through G5], strict internal-link check on full tree, generate green, dark/light+mobile spot-check, re-run T3.1's deferred quick-start commands), fix/ticket findings → that closes **Gate 3** for everything except the T4.1 sweep. Plan is DONE once T4.1 lands (post-0002-confirm) + T4.2 green. (T4.1 cutover + T4.3 CI/deploy — disjoint; **T4.1 needs 0002 fully done**): T4.1 = migrate/delete `docs/*.md` → stub (site + `work/` pointers), relocate not-migrated docs per ia.md table (`casdk-mapping.md`, `differences-from-electric-agents.md`, `self-hosting-networking.md` → `work/plans/0001-build-v1/notes/`), repo-wide dangling-`docs/`-ref sweep, **diff `docs/` vs baseline `c98d504`** to absorb any `0002:T5.4` fixes; also fix stale source headers found in G3/G4 (see below). T4.3 = CI job on **Node 22** (docs `generate`) + deploy options + `git remote add origin git@github.com:everynow-dev/teaspill.git` note.
- **Then G7** (T4.2 QA = **Gate 3**): fresh-eyes read-through, public-voice grep audit, strict internal-link check (full tree, then flip `failOnError` back to true or assert on log), generate green, dark/light + mobile spot-check, **re-run the quick-start/installation commands T3.1 could NOT run live** (see G4 entry: fresh-clone/bundle/`docker compose up --build`, `teaspill dev` with COMPOSE_FILE, the `packages/my-agents` scaffold mechanics, all model-dependent outputs — no ANTHROPIC_API_KEY was available; browser `createAgentTimeline` snippet).
- **Wave-2 docs/ baseline (for T4.1 diff):** `c98d504`.
- **Ledger note (2026-07-19):** on-disk 0002 ledger showed `active`/G5-done at G4 dispatch; user stated 0002 fully done. Proceeded; Wave-2 docs were verified against **current code** (T3.1 even ran the quick-start live against the running stack), so they track code reality regardless. T4.2 re-checks the deferred live commands.
- **Stale SOURCE files to fix at T4.1 (found during G3/G4 content verification — these are code/README bugs, not doc bugs):** `packages/schema/src/index.ts` header "PROPOSED/freezes at gate" (schema is frozen v1); `packages/harness-native/README.md:4` "PROPOSED"; `packages/gateway/README.md:34-40` stale manual-SQL key-minting (superseded by `teaspill keys` + `@teaspill/catalog createApiKey`); `packages/conformance/README.md` "ready-made agents not yet shipped" (they ship in reference-deployment); `packages/cli/README.md` omits `keys`; `docs/agents-sdk.md:171-173` shows `emit({...})` but real sig is `emit([...])` (array); `docs/agents-sdk.md:290` hand-waves `platformDeps`. **Repo follow-up candidates (not docs):** no runnable `teaspill` bin from repo root (root has no `@teaspill/cli` dep); `send` shorthand-body normalization is a reference-deployment-only pattern, not exported.
- **Cross-page fix already applied (main session, G4 merge):** stream paths use `/agents/` (`STREAM_COLLECTION`), NOT `/a/` (`ENTITY_MARKER`). T3.4's auth-api-keys had `/streams/.../a/researcher/...` — corrected to `/agents/`. All other pages already correct. (Entity URLs / CLI short form correctly use `/a/`.)
- **Gates status:** Gate 1 — **PASSED** (G2). Gate 2 — **CLEARED** (0002 per user). Gate 3 (T4.2 QA) — not reached.
- **Open amendments:** —
- **Carry-forwards:**
  - at Gate 2, before dispatching Wave 2, note the git revision of `docs/` that Wave-2 content agents read; T4.1 later diffs against it to absorb any `0002:T5.4` corrections.
  - **Node ≥22.5 required** to build/run `@teaspill/docs` (Nuxt Content `sqliteConnector: 'native'` → `node:sqlite`). Root `engines.node` stays `>=20.19.0` (unchanged); the constraint is documented in `packages/docs/README.md`. **T4.3 must run the docs CI job on Node 22** — root CI (`.github/workflows/ci.yml`) is Node 20 and would fail docs `generate`.
  - **Fresh-worktree checks:** `pnpm -r typecheck` needs non-docs packages built first (`pnpm -r --filter '!@teaspill/docs' build`) — cross-package imports resolve to `dist/`. Pre-existing repo behavior; run a build before the root checks to reproduce green.
  - **h3 pinned to 1.15.11** (root `pnpm-workspace.yaml` `overrides`) — R3 template-drift fix; revisit when nitro adopts h3 v2.
- **To continue in a fresh session:** read this plan's PLAN.md + `notes/template-research.md` + this pointer + `git log --oneline`, check `work/INDEX.md` and 0002's resume pointer (Gate 2 wait state), then dispatch the next group. If Wave 1 is done and 0002 hasn't reached its Gate-2 milestones, flip this plan to `paused` in INDEX and stop. Assign models by S/M/L tier via the dispatch profile in `work/README.md`.

---

## G6 (partial) — T4.3: Deployment & CI wiring ✅ (T4.1 held — see resume pointer)

`.github/workflows/ci.yml` split into two jobs: `ci` (Node 20.19.0) now runs `pnpm -r --filter '!@teaspill/docs' run typecheck` (docs excluded — its `nuxt typecheck` needs Node ≥22.5 `node:sqlite`; root `pnpm lint` already ignores docs; `pnpm test` skips docs' missing test script) + a new `docs` job (Node 22.17.1) running docs lint + typecheck + `generate` with `NUXT_PUBLIC_SITE_URL` set. `packages/docs/README.md` gained a **## Deployment** section: static-host + Vercel options, `NUXT_PUBLIC_SITE_URL` + Node-22 build notes, and the `git remote add origin git@github.com:everynow-dev/teaspill.git` reminder (worktree has no remote). Actual host/domain left to the user per T4.3 scope. **T4.1 (docs/ retirement) intentionally NOT bundled** — blocked on 0002-done confirmation (resume pointer).

---

## G5 — T3.7: AI surface & site plumbing ✅ (done inline by main session)

Solo task, no parallel race — main session did it directly. `nuxt.config.ts`: remapped `nuxt-llms` `title`→"teaspill", `description`/`full` to teaspill copy, and `sections` to the real tree (Getting Started · Concepts · Guides · Reference · Contributing, each `path LIKE /<section>%`); `mcp.name`→"teaspill docs". Deleted template placeholder dirs `content/2.essentials/` + `content/3.ai/`. Verified via `generate`: `/llms.txt` now lists all 5 real sections with per-page raw-markdown links (`/raw/<path>.md`), 115 routes, zero broken links, no lingering essentials/ai references anywhere. **Bug fixed en route:** `4.reference/4.cli.md` frontmatter `description` had an inner `: ` (`every command: dev…`) → YAML mis-parsed to an object, surfacing as `[object Object]` in llms.txt; quoted the string. (Note: `llms.domain` + site URL were set earlier in the resume-config commit.)

---

## G4 — T3.1 · T3.3 · T3.4 (Wave 2 content). Wave 2 complete. ✅

Three content agents in parallel over disjoint dirs; all followed style-guide + ia.md, verified against `packages/*/src`, heeded the steer/resurrection/workspaceRef seam findings. Ban-list grep clean across all new pages. Consolidated `generate` = **115 routes, zero broken links** (all previous Wave-2 forward-links now resolve). Note: subagents can't WebFetch (OAuth) — they used the sanctioned `template-research.md` §3 digest (T3.4 reported fetching; T3.1/T3.3 used the digest).

### T3.1 — Landing + Getting Started (L) ✅ — `content/index.md` + `content/1.getting-started/`
Landing (MDC hero, 6 cards, `defineAgent` teaser) + Introduction (756w) + Installation (568w, `::steps`) + Quick start (Pattern B, live-verified) + Architecture (986w, neutral, 2 accordions, ASCII diagram). Deleted template `3.usage.md`. **Ran the quick-start LIVE against the running stack** (booted by the parallel 0002 session): `serve()` deployment registered through the gateway, spawn, canonical send, timeline events via real outbox wiring, archive, deregister — all confirmed with real entity URLs. **Deferred to T4.2 (could not run live):** fresh-clone/`pnpm install`/`pnpm -r build`/`bundle`/`docker compose up --build` (stack was already up); `packages/my-agents` scaffold mechanics (path-ownership); `teaspill dev` w/ COMPOSE_FILE; **all model-dependent outputs** (no ANTHROPIC_API_KEY — sample `logs` output marked illustrative, format faithful to `render.ts`); browser `createAgentTimeline` snippet (verified vs `timeline.ts`/`reducer.ts`, not browser-run). Discrepancies: no root `teaspill` bin; `send` shorthand-body is reference-deployment-only; `docs/agents-sdk.md` `platformDeps` hand-wave — all handled in-page + logged for T4.1.

### T3.3 — Guides: agents & frontend (M) ✅ — `content/3.guides/1.agents/` + parent `3.guides/.navigation.yml`
Building agents (~1,940w, Pattern B) + Frontend integration (~1,395w). Created the parent Guides nav (T3.3-only per ia §3). Verified 6 platform tools (`spawn_agent`/`send_message`/`list_children`/`wait`/`finish`/`set_status`, `tools.ts:62-69`) + 5 workspace tools (`bash`/`read_file`/`write_file`/`edit_file`/`ls`, `workspace-tools.ts:69-77`) against code. **Steer correctly excluded from browser/CLI** (frontend actions client has none — `actions.ts`); agent page frames `mode:"steer"` as agent-to-agent only. Resurrection archiveCatalog caveat stated. Fast-join `fromSnapshot:{seq,offset?}` documented with `fromSnapshotForRow` helper (fixes §9.6 lag). Found `docs/agents-sdk.md` `emit` shown as single-object vs real array sig.

### T3.4 — Guides: operations (M) ✅ — `content/3.guides/2.operations/`
Self-hosting (~1,150w) + Auth & API keys (~1,000w) + Backup & restore (~1,150w), all Pattern B; own subgroup nav (parent untouched). Verified backup/restore flags + the **restore matrix** against `scripts/{backup,restore}.sh` (full=clean; catalog+streams w/o coordination = archived resurrect, never-archived lost loudly; coordination+catalog w/o streams = runs w/ marked history hole; else unsupported). Verified `teaspill keys` flags (`cli.ts:165-176`, `keys.ts`), auth/JWT (`gateway/src/{auth,jwt}.ts`), networking `::warning` + Docker-socket `::caution`. **Main session corrected** T3.4's stream-path example: it used `/streams/.../a/researcher/...` but code is `STREAM_COLLECTION="agents"` → fixed to `/agents/` (T3.4 mis-flagged `docs/auth.md`'s `/agents/` as stale; it was right).

---

## G1 — T1.1: Scaffold `packages/docs` from the Nuxt UI docs template ✅

**Scaffold method:** `npm create nuxt@latest -- -t ui/docs --no-install` into the scratchpad, then copied source into `packages/docs/` (40 tracked files). Excluded template-meta the repo already owns: `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `LICENSE`, `renovate.json`, template `.github/` (T4.3 owns CI), `.editorconfig`.

**Versions (exact digest/D1 match, no drift):** nuxt ^4.4.8, @nuxt/ui ^4.10.0, @nuxt/content ^3.15.0, @nuxt/image ^2.0.0, nuxt-og-image ^6.7.2 (+@takumi-rs/core ^1.8.7), nuxt-llms 0.2.0, @nuxtjs/mcp-toolkit ^0.18.0, @nuxtjs/mdc ^0.22.1, tailwindcss ^4.3.2, zod ^4.4.3; dev: typescript ^6.0.3, vue-tsc ^3.3.7, @nuxt/eslint ^1.16.0.

**package.json:** name `@teaspill/docs`, `private: true`, version 0.1.0; **`packageManager` removed**; scripts `dev`/`build`/`generate`/`preview`/`postinstall`(nuxt prepare)/`lint`/`typecheck`(`nuxt typecheck` → vue-tsc). **No `test` script** (root `pnpm -r test` skips it).

**Lint choice:** `packages/docs/**` added to root `eslint.config.js` `ignores`; package self-lints via its local `@nuxt/eslint` flat config (`eslint.config.mjs`) + local `lint` script. Avoids Nuxt's Vue/generated-code config fighting the strict root typescript-eslint rules.

**gitignore choice:** package-local `packages/docs/.gitignore` (from template) covers `.nuxt/.output/.data/.nitro/.cache/dist/node_modules/logs/.env`. Root `.gitignore` untouched. Verified via `git check-ignore` — no build artifacts staged (40 clean files).

**pnpm build-script decls (root `pnpm-workspace.yaml`):** pnpm 11 errors on any undeclared build script (cascades into `generate`'s dep-status check). Added `sharp: true` (native image/OG for `generate`) to both `allowBuilds` + `onlyBuiltDependencies`; `@parcel/watcher`/`unrs-resolver`/`vue-demi` → `false` (JS/WASM fallbacks, postinstalls unneeded, matches upstream). `@takumi-rs/core` + `@tailwindcss/oxide` ship prebuilt binaries (no build script).

**R3 template-drift — h3 pin (`overrides: h3: 1.15.11`):** in the full workspace graph, `nuxt generate` crashed on 3 routes with *"Cannot read properties of undefined (reading 'append'/'set')"* in h3's header helpers. Cause: nitro depends on h3 v1 and creates v1 prerender events; nuxt-og-image/nuxt-llms have no own h3 and compiled against h3 `2.0.1-rc.22` (resolved from `@nuxtjs/mcp-toolkit`'s loose `>=1.15.11` peer), which reads `event.res` (absent on v1 events). No package needs h3 ^2, only docs pulls h3 → pin whole tree to nitro's v1 major. Lockfile has zero h3-v2 refs after; `--frozen-lockfile` stable.

**Node/sqlite:** `@nuxt/content` `sqliteConnector: 'native'` → `node:sqlite`, needs Node ≥22.5 (works on local v22.17.1, absent on Node 20). Root engines left at `>=20.19.0`; Node ≥22.5 requirement documented in `packages/docs/README.md` (better-sqlite3 connector = cross-version fallback). See carry-forward for CI impact.

**DoD (all green, independently re-verified by main session):**
1. `pnpm install` ✅ (build approvals via workspace config, no prompt).
2. `pnpm --filter @teaspill/docs dev` ✅ boots `Nuxt 4.4.8 … Local: http://localhost:3000/`, `curl` → HTTP 200.
3. `pnpm --filter @teaspill/docs generate` ✅ `Prerendered 42 routes` / `Generated public .output/public`, **NUXT_PUBLIC_SITE_URL unset** (main session re-ran: 42 routes in 10.1s).
4. `pnpm -r typecheck` ✅ 15 packages Done (docs typechecks; note fresh-worktree build-first — carry-forward).
5. `pnpm -r test` ✅ docs skipped cleanly, others pass.
6. `pnpm lint` ✅ (main session re-ran, clean).

**Deviations from digest:** none in versions. Added: h3 override (R3) + four build-script decls — both required for install/generate in the workspace, commented inline.

**Handoffs:** T1.2 owns `app.config.ts` (green/slate → spilled-tea) + `AppLogo` + OG template + `main.css`. T1.3 owns changelog collection/page. T3.7 owns nuxt-llms/mcp section mapping + placeholder-content deletion. Template placeholder content (`content/1.getting-started`, `2.essentials`, `3.ai`) left as-is.

---

## G2 — T1.2 · T1.3 · T2.1 (Wave 1 theme/changelog/IA). Gate 1 passed. ✅

**Interruption note:** the session token limit hit mid-G2. All three agents wrote their deliverables to the working tree before terminating; the main session verified completeness on resume (nothing needed re-dispatch), ran the consolidated build, did the Gate 1 review, and committed.

### T1.2 — "Spilled tea" theme (colors, fonts, logo) ✅
- **Palette (custom `@theme` scales in `app/assets/css/main.css`):** primary `tea` — steeped-copper ramp 50 `#FDF6EF` → 500 `#C86B34` → 600 `#B0521F` → 950 `#2C1308` (not mustard). neutral = stock `stone`. success/accent = custom `matcha` ramp (50 `#F5F8EC` → 500 `#7C9E3B` → 950 `#1A240D`). Wired in `app.config.ts` `ui.colors { primary:'tea', neutral:'stone', success:'matcha' }`.
- **Contrast (D5 anticipate):** copper 500 only ~3.7:1 on white (fails AA). Override in main.css: `--ui-primary: tea-600` (light, ~5.2:1) / `tea-400` (dark, on warm near-black). Dark mode = warm near-black via stone neutral.
- **Fonts** via Nuxt UI's auto-registered `@nuxt/fonts`, configured in `nuxt.config.ts` `fonts.families` (google): **Fraunces** 400–700 +italic (display/headings, `--font-display`, applied to h1–h6 with optical sizing), **Public Sans** 400–700 (body, `--font-sans`), **JetBrains Mono** 400–600 (code, `--font-mono`). Verified provisioned during generate.
- **Logo/marks:** `AppLogo.vue` rewritten as inline teacup+spill SVG (cup=currentColor light/dark-adaptive, tea surface+spill+steam=`--ui-primary`) + "teaspill" wordmark in display serif. `public/favicon.svg` added (821B), wired via `nuxt.config` `app.head.link`. `OgImage/Docs.takumi.vue` retinted to palette.
- **app.config.ts:** siteName "teaspill"; header wired to AppLogo; header nav link `Changelog → /changelog` (wires T1.3's page); GitHub links + edit link = **placeholder `https://github.com/everynow/teaspill`, all marked `TODO(repo-url)`** (see OPEN FLAG); dropped Nuxt Discord/X footer links; `TemplateMenu.vue` deleted.
- **Hero/bg:** `StarsBg.vue` restyled off the stars motif to the tea palette (per D5 anticipate — don't leave a motif that fights identity).
- **Note:** `llms`/`mcp` config in nuxt.config left at template defaults (T3.7 owns AI-surface remap). Main session `--fix`'d one `nuxt/nuxt-config-keys-order` lint nit post-merge.

### T1.3 — Changelog section (content-driven, D2) ✅
- `content.config.ts`: added `changelog` collection (`source: 'changelog/**'`, schema `date` required + `badge`/`image` optional); excluded `changelog/**` from the `docs` collection source glob so entries never hit the sidebar/⌘K (both built from `docs` collection via `app/app.vue`). Seed entry also carries `navigation: false` (belt-and-suspenders).
- `app/pages/changelog.vue` (new): `queryCollection('changelog').order('date','DESC').all()` → `UChangelogVersions`/`UChangelogVersion` (props verified against installed @nuxt/ui 4.10: title/description/date/badge/image; body via `#body` slot + `ContentRenderer`).
- `content/changelog/v1.md` (new): "teaspill v1" entry, public-voice clean (grep for id/ledger patterns = zero hits). Highlights derived from `docs/README.md` + package READMEs.
- `packages/docs/README.md`: appended `## Changelog` authoring flow + noted future Changesets-generation option (not built).
- Verified: `/changelog` prerenders in consolidated generate; absent from docs nav/search.

### T2.1 — IA + writing style guide (L, critical, Gate 1) ✅
- `notes/style-guide.md` (24KB): voice/tone rules + fluff ban list; the two page patterns (Nuxt hub A / Laravel task B) + which section uses which; **the terminology ramp R1–R16** (durable agent → gateway → durable execution → virtual object/single-writer → wake → entity → timeline/event → token delta → projection/outbox → catalog → snapshot/fast-join → workspace/executor → harness → control verb → archive/resurrection → steer) with plain-English defs + the absolute "no undefined term" rule + internal-only vocab blocklist; the **D4 expandable-context pattern** = single-item `::accordion` with a worked example converting a real `docs/frontend-sdk.md` "(A6)" cross-ref; the public-voice ban list (grep patterns for T4.2); glossary spec; a **citation ledger** of what each Nuxt/Laravel reference page contributes; and a **§9 stale-doc list** content agents must heed (cli README missing `keys`, gateway README stale key-minting, schema/harness-native "PROPOSED", conformance "not yet shipped", port 8787 not 8080, `fromSnapshot {seq, offset?}`, addressing helpers now in `@teaspill/schema`).
- `notes/ia.md` (33KB): full page tree mapped to template dirs with per-page owner(T3.x)/wave/pattern/length/outline/sources; Getting-Started(T3.1) · Concepts 10 pages incl. glossary(T3.2) · Guides agents+ops(T3.3/T3.4) · Reference 5 pages incl. new Gateway-API page(T3.5) · Contributing index+package-map(T3.6) · AI-surface(T3.7). G4 path-disjointness note (T3.3/T3.4 split `3.guides/` subdirs; parent `.navigation.yml` owned by T3.3). **electric-agents verdict:** no comparison page — absorb into a neutral `4.architecture.md` (KEEPS→capabilities, CHANGES→design principles, DROPS→"what teaspill deliberately doesn't do"), war-stories not published. **Not-migrated table (D3):** `casdk-mapping.md` + `differences-from-electric-agents.md` + `self-hosting-networking.md` relocate to `work/plans/0001-build-v1/notes/` at cutover; every internal doc accounted for in a coverage check.
- **Gate 1 review (main session):** both artifacts approved — self-consistent, ramp respected, wave split correct, D4-compliant, every page owned. No changes requested.

**Consolidated build (main session, post-merge):** `pnpm --filter @teaspill/docs generate` ✅ 45 routes incl. `/changelog`, fonts provisioned, favicon.svg emitted (mcp-toolkit "needs a server" warning is expected/harmless for static — T3.7 territory). Docs lint ✅ (after one `--fix`), docs typecheck ✅, root lint ✅.

---

## G3 — T3.2 · T3.5 · T3.6 (Wave 1 content). Wave 1 complete. ✅

Three content agents in parallel over disjoint content dirs, all following `notes/style-guide.md` + `notes/ia.md`, all WebFetched the cited Nuxt/Laravel reference pages, all verified claims against `packages/*/src`. Ban-list grep across all 17 pages = clean (zero id/ledger/competitor/PROPOSED hits); exactly one sanctioned `work/` pointer (contributing index, §5-correct wording).

### T3.2 — Concepts (L) ✅ — `content/2.concepts/` (10 pages + .navigation.yml)
durable-agents · restate-primer · entities-addressing · timelines-events · projections-catalog · workspaces · harnesses · multi-agent · lifecycle · glossary. Ramp R1–R16 honored in reading order (forward-uses link to defining page/glossary anchor); 10 accordions (≤2/page), Pattern A hub style, ~600–800w each, glossary ~1,200w. Running example (researcher/summarizer) used site-wide. Code-verified (e.g. pause/resume mailbox semantics against `coordination/src/agent.ts`; workspace docker-adapter against `executor`). Findings: steer external-surface gap + resurrection archive-catalog caveat + harness-native README staleness (all captured in resume pointer). Minor open items for T4.2 taste/polish: `entities-addressing` sits at the −30% length floor (could thicken); `lifecycle` uses an ASCII state diagram (template has no mermaid — could upgrade to SVG); glossary `#child_finished` deep-link assumes underscore-preserving slugs (verify in preview).

### T3.5 — Reference (M) ✅ — `content/4.reference/` (5 pages + .navigation.yml)
events (schema) · addressing · gateway-api · cli · configuration. Pattern B spec-variant, terse/table-driven. **Everything verified against code, not docs:** 15 event types + 6-field envelope (`schema/src/events.ts`), 4 delta kinds (`deltas.ts`), 7 CLI commands incl. `keys` (`cli/src/cli.ts` — README omits it), gateway routes + spawn-202 body `{url,streamPath,streamUrl,restate}` (`gateway/src/routes/api.ts`), port **8787** (8080 = Restate ingress, correctly labeled), addressing helpers/regex/caps (`schema/src/addressing.ts`), config defaults against compose + `.env.example`. Extra stale spot surfaced: `schema/src/index.ts` header still "PROPOSED".

### T3.6 — Contributing (M) ✅ — `content/5.contributing/` (2 pages + .navigation.yml)
index (Pattern A, ~470w) + package-map (~1,850w, all 13 non-docs packages, grouped You'll-use / Platform / Quality-kits, contributor-only flagged in first sentence, machine-room depth sanctioned — names outbox/reconciler/adapter+harness seams, still zero ids). The one `work/` design-history pointer with exact §5 wording. Corrected 5 stale-README spots against code (schema/harness-native "PROPOSED"→frozen v1; conformance "not yet shipped"→ships in reference-deployment; cli missing `keys`; frontend-sdk fromSnapshot).

**Consolidated build (main session):** `generate` initially exited 1 — crawlLinks 404'd on the 6 Wave-2 forward-links (legit, pages not written yet). Set `nitro.prerender.failOnError:false` (staged-build accommodation, documented inline; T4.2 owns the strict link check) → `generate` ✅ **96 routes**, only the 6 expected Wave-2 404s remain (visible, non-fatal).
