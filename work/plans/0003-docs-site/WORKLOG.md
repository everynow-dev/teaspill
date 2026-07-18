# 0003 — Worklog

Append-only findings ledger. One entry per completed task: what was built, deviations, surprises, open questions. Read before starting dependent work.

---

## ▶ RESUME POINTER (main session — update after every group)

- **Status:** G1 + G2 done. **Gate 1 PASSED** (main session reviewed `notes/style-guide.md` + `notes/ia.md` — both approved). Next: dispatch **G3** (T3.2 concepts · T3.5 reference · T3.6 contributing — Wave 1 content, parallel, disjoint content dirs). Content agents MUST read `notes/style-guide.md` + `notes/ia.md` + `notes/template-research.md` §3 (open the cited reference pages) + their named sources, and verify claims against code (style-guide §9 lists known stale-doc spots). **After G3, Wave 1 ends → Gate 2 wait** (check 0002 resume pointer; if 0002 hasn't hit `0002:T4.1` landed + `0002:T4.2` green, flip 0003 to `paused` in INDEX and stop).
- **⚠ OPEN FLAG for user:** repo GitHub URL is a placeholder `https://github.com/everynow/teaspill` (worktree has no git remote) — used in `app.config.ts` (header/footer/edit links, marked `TODO(repo-url)`) and the style-guide's `work/` pointer wording. User must confirm the real org/repo before launch (T4.3).
- **Gates status:** Gate 1 (T2.1 IA/style review) not reached · Gate 2 (0002 wait: needs `0002:T4.1` landed + `0002:T4.2` green for G4; 0002 fully done for G6) not reached · Gate 3 (T4.2 QA) not reached.
- **Open amendments:** —
- **Carry-forwards:**
  - at Gate 2, before dispatching Wave 2, note the git revision of `docs/` that Wave-2 content agents read; T4.1 later diffs against it to absorb any `0002:T5.4` corrections.
  - **Node ≥22.5 required** to build/run `@teaspill/docs` (Nuxt Content `sqliteConnector: 'native'` → `node:sqlite`). Root `engines.node` stays `>=20.19.0` (unchanged); the constraint is documented in `packages/docs/README.md`. **T4.3 must run the docs CI job on Node 22** — root CI (`.github/workflows/ci.yml`) is Node 20 and would fail docs `generate`.
  - **Fresh-worktree checks:** `pnpm -r typecheck` needs non-docs packages built first (`pnpm -r --filter '!@teaspill/docs' build`) — cross-package imports resolve to `dist/`. Pre-existing repo behavior; run a build before the root checks to reproduce green.
  - **h3 pinned to 1.15.11** (root `pnpm-workspace.yaml` `overrides`) — R3 template-drift fix; revisit when nitro adopts h3 v2.
- **To continue in a fresh session:** read this plan's PLAN.md + `notes/template-research.md` + this pointer + `git log --oneline`, check `work/INDEX.md` and 0002's resume pointer (Gate 2 wait state), then dispatch the next group. If Wave 1 is done and 0002 hasn't reached its Gate-2 milestones, flip this plan to `paused` in INDEX and stop. Assign models by S/M/L tier via the dispatch profile in `work/README.md`.

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
