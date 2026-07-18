# 0002 — Worklog

Append-only findings ledger. One entry per completed task: what was built, deviations, surprises, open questions. Read before starting dependent work.

---

## ▶ RESUME POINTER (main session — update after every group)

- **Status:** G1 done + committed (T1.1 · T1.2 · T1.3, all green). Next: dispatch **G2** (T1.4 · T1.5 · T5.2).
- **Gates status:** Gate 1 (T2.1 property suite) — pending. Gate 2 (T4.2 live conformance) — pending.
- **Open amendments:** none.
- **Carry-forwards:** (T1.1) schema has no first-party unit test for `addressing.ts` — behavior covered via gateway (72) + frontend-sdk (51) tests; candidate for a future coverage task. (T1.1) schema `TYPE_RE`/`ID_RE` length caps (48/64) now apply to frontend-sdk `entityApiPath` — a spec-correct tightening, no existing test exercised overlong segs. (T1.3) `FakeStreamsServer` stays in conformance (materially different fake w/ restart/dedupBySeq/rawRecords); only the `validateProducer` protocol fn was promoted.
- **To continue in a fresh session:** read `work/plans/0002-follow-ups/PLAN.md` + this pointer + `git log --oneline`, check `work/INDEX.md` for other active plans (package-overlap rule), then dispatch the next group. Assign models by S/M/L tier via the dispatch profile in `work/README.md`.

---

## G1 — Debt & seam cleanups (committed)

### T1.1 — Promote addressing helpers to `@teaspill/schema`

Moved the canonical addressing derivation functions (docs/addressing.md §9) into a new `packages/schema/src/addressing.ts`, exported from `packages/schema/src/index.ts`. Ported the FULL reference implementation (not just the subset gateway had), including `AddressingError`, `entityUrl`/`parseEntityUrl`/`isEntityUrl`, `toHttpForm`/`fromHttpForm`, `newInstanceId`/`assertInstanceId`, stream-path derivations, workspace-key derivation, and the Restate key mapping (`restateAgentKey`/`steerKey`/`restateWorkspaceKey`/`restateCronKey`/`timelineProducerId`), plus all constants/regexes.

- `packages/gateway/src/addressing.ts`: gutted to a thin re-export of the names gateway consumers use. Kept the file (not deleted) because `addressing.test.ts`, `ingress.ts`, `r5-streams.test.ts` import `"./addressing.js"` by relative path. Added `@teaspill/schema: workspace:*` to gateway package.json (was not a dep before).
- `packages/frontend-sdk/src/actions.ts`: replaced local `SHORT_FORM_RE`/`CANONICAL_RE`/`SEG_RE` with schema's `SHORT_FORM_RE`/`ENTITY_URL_RE`/`TYPE_RE`/`ID_RE`. Already depended on schema.
- Added `ulidx: ^2.4.1` to schema package.json (needed by `newInstanceId`).
- Did NOT touch events.ts/deltas.ts (frozen-surface rule; verified via git status).

Deviation: schema's `TYPE_RE`/`ID_RE` impose length caps (48/64, per addressing.md §2.3) that frontend-sdk's old `SEG_RE` did not — a behavior tightening (spec-correct), no test exercises overlong segs, both suites green with zero assertion changes. Open: no first-party schema unit test for addressing.ts (see resume pointer carry-forward).
Verify: schema typecheck/test (65)/build/lint, gateway typecheck/test (72)/lint, frontend-sdk typecheck/test (51)/lint — all PASS. Root `pnpm lint` PASS.

### T1.2 — `packages/agents-sdk` README

Wrote `packages/agents-sdk/README.md` (previously the only package without one). Covers: `defineAgent` (fields, validation, `.compile`/`.compileConfig`/`.registration()`), harness selection (`native`/`claudeAgentSdk`, shared tool-context wiring, CASDK lazy-load), the `onWake` contract (quotes 0001:A10 — hand-off vs onWake-only, resurrection tie-in), registration (`serve`/`registerDeployment`, one-attempt-throws owned by `teaspill dev`, `CompileDeps` seams), revision rules (additive-only, `StateRevisionError`, `diffStateSchema`/`assertStateRevision`), plus `mintReadToken` and coordination re-exports (`createDrizzleArchiveCatalog`, `ArchiveCatalog`), and a layout table. Design-note tone matching schema/harness-native READMEs; deep content linked to `docs/agents-sdk.md` by anchor, not duplicated. No surprises vs docs — export surface matches the guide exactly.

### T1.3 — Export coordination test utilities

Exported `FakeTimelineServer` and `validateProducer` from `@teaspill/coordination` under a new `./testing` subpath export → `dist/testing/fake-timeline-server.{js,d.ts}` (kept off the main entry `src/index.ts` — no accidental prod dep; build already emitted the artifact via `tsconfig.build.json` include, no build-config change). Deleted the line-for-line `validateProducer` re-port from conformance's `fake-streams.ts`; it now imports the canonical fn from `@teaspill/coordination/testing`, and conformance `index.ts` re-exports it from there. `FakeStreamsServer` stays in conformance (materially different fake — restart/dedupBySeq/rawRecords chaos needs; only the protocol fn was in scope). Workspace dep already present in conformance + chaos. Chaos never imported `validateProducer` directly (only `FakeStreamsServer` via conformance) — zero chaos source changes.
Verify: coordination build/typecheck/test (171 pass, 4 skip)/lint, conformance build/typecheck/test (17 pass, 5 skip)/lint, chaos typecheck/test (16 pass, 5 skip)/lint — all PASS.
