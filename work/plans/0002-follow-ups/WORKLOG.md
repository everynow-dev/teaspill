# 0002 — Worklog

Append-only findings ledger. One entry per completed task: what was built, deviations, surprises, open questions. Read before starting dependent work.

---

## ▶ RESUME POINTER (main session — update after every group)

- **Status:** G2 done + committed (T1.4 · T1.5 · T5.2, all green). Next: dispatch **G3** (T2.1 · T5.1). ⚠ G3 contains the critical L task T2.1 (Gate 1 closes here) — same rigor as 0001 Gate 3; dispatch T2.1 to the L tier and give it a quiet group.
- **Gates status:** Gate 1 (T2.1 property suite) — pending (closes in G3). Gate 2 (T4.2 live conformance) — pending.
- **Open amendments:** **0002:A1** (T1.4) — Restate handler names may not contain a dot; camelCase FS handlers permanent. Binding.
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

---

## G2 — name-map verdict, fast-join plumb, docker hardening (committed)

### T1.4 — Handler-name grammar: dotted names settled (dots ILLEGAL in handler names)

Added ephemeral probe `references/restate-spike/src/dotted-handler-probe.ts` (spike dir gitignored — not committed; verdict is the durable artifact) and ran it against live Restate 1.7.2 (`operea-restate-1`, ingress :8080 / admin :9070, ports discovered via `docker port`, not assumed). **Verdict: dotted HANDLER names ILLEGAL, dotted SERVICE names LEGAL.** SDK constructs `fs.read` silently but admin `POST /deployments` discovery rejects it (HTTP 500, pattern `^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9_]*$`); control probe registered dotted service `agent.researcher` at HTTP 201 → `agent.<type>` scheme confirmed sound (closes addressing.md §10.5). camelCase FS handlers (`fsRead`… ) BLESSED permanent; NO handler renamed (none needed). Documented: `docs/addressing.md` §6.1 (new, with verbatim evidence) + §10.5 marked RESOLVED. Authoritative public→internal name-map = `AGENT_HANDLERS` in `packages/gateway/src/routes/api.ts` (confirmed single, no second inline map); gateway/executor source untouched (read-only inspection). Both probe deployments deregistered — live Restate returned to prior state. Amendment **0002:A1** recorded. Non-blocking follow-up for T5.4 docs sweep: comment at `packages/executor/src/workspace.ts:30-34` still says dots "not verified" — can now cite T1.4.

### T1.5 — Fast-join byte offset: plumb `snapshot_stream_offset` to the reader

Catalog column `snapshot_stream_offset` (opaque durable-streams BYTE offset, TEXT, from 0001:T8.1) was never surfaced by frontend-sdk, so `createAgentTimeline` scanned from 0. Distinct from `snapshot_offset` (bigint canonical **seq**, already surfaced). Surfaced byte offset as `EntityRow.snapshotStreamOffset: string | null` via new `toOpaqueOffset()` (preserves TEXT token, never arithmetic; empty ⇒ null). New exported `fromSnapshotForRow(row)`: no seq ⇒ undefined (full replay); byte offset NULL ⇒ `{seq}` only (reader scans "-1", reducer resolves at seq floor); both present ⇒ `{seq, offset}` (cheap seek). Reader already consumed `opts.fromSnapshot?.offset ?? "-1"` — only population was missing, no reader change. NULL fallback preserved 3 places. Conformance (reducer.conformance.test.ts): +2 e2e scenarios (byte offset landing BEFORE snapshot still resolves via seq floor `skippedPreJoin===3`; NULL offset falls back to scan-from-0). Live smoke (timeline.live.test.ts, skip-guarded on `TEASPILL_LIVE_STREAMS_URL`) extended with early-offset assertion against real :0.1.4. Reducer early-offset tolerance (0001:A6#5/A7) was already implemented; this closed the catalog→timeline plumbing gap. Docs note: frontend-sdk.md example still hand-wires `fromSnapshot` — adopt `fromSnapshotForRow` in T5.4 sweep. No @teaspill/catalog change (column already exposed). Verify: frontend-sdk typecheck/test (57 pass, 1 live skip)/lint PASS.

### T5.2 — Docker adapter prod hardening

Closed 0001:T4.2's 3 open items; adapter INTERFACE unchanged (config + defaults only). (1) `DEFAULT_DOCKER_IMAGE` now digest-pinned `alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc` (multi-arch index digest, captured 2026-07-18 from daemon; refresh recipe inline). (2) New `DockerNetworkMode = "none"|"bridge"|(string&{})` per-workspace + adapter-level `network` option → `docker run --network`; **default `"bridge"`** (documented — agents need egress for tool calls; `"none"` for untrusted code). (3) Socket-mount prod tradeoff documented (not built; no DinD) — "Production hardening" section in docker-adapter.ts module doc + docs/self-hosting.md block making explicit that digest-pin+network harden *workspaces* NOT the socket-mounted executor (multi-tenant hostile-code still needs rootless DinD / VM adapter). +6 tests in docker-lifecycle.test.ts (fake captures full create spec). Verify: executor typecheck/test (89, incl. 9 real-container ran)/lint PASS.
