# 0003 — Worklog

Append-only findings ledger. One entry per completed task: what was built, deviations, surprises, open questions. Read before starting dependent work.

---

## ▶ RESUME POINTER (main session — update after every group)

- **Status:** G1 done (T1.1 scaffold committed). Next: dispatch **G2** (T1.2 theme · T1.3 changelog · T2.1 IA/style — parallel, path-disjoint). **Gate 1** closes G2 (main session reviews T2.1's `style-guide.md` + `ia.md` before any Phase 3 dispatch). **Wave 1 only (G1–G3)** — Wave 2 blocked by Gate 2 (cross-plan wait on 0002).
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
