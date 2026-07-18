# 0002 — Post-v1 follow-ups: debt, recovery wiring, live validation

Plan 0001 delivered the full teaspill v1 build (38 tasks, 13 packages, ~751 tests, schema frozen, D5 warm path validated). It deliberately left behind a documented set of non-blocking follow-ups, deferred wirings, and everything gated on a *live running stack*. This plan collects all of them from 0001's ledgers into one organized initiative: pay down the small debts, wire the deferred recovery path (`0001:A9`), complete the frozen-interface-adjacent improvements, and — the centerpiece — stand up a real deployment and turn the skip-gated live conformance/chaos suites green. This document is self-contained for its executors.

---

## 1. Background and motivation

Every item here originates from 0001's WORKLOG resume pointer ("Residual non-blocking follow-ups" + per-task Open items) and DECISIONS amendments. Nothing is speculative new scope; the one genuinely new artifact (a reference agent deployment, T4.1) exists because the live suites cannot run without *some* deployed agent-loop and executor service — compose intentionally ships none (`0001:D4`: those planes are developer-deployed).

Themes, in dependency order:

1. **Debt/seams (Phase 1):** duplicated addressing fns, missing exports/README, the dotted-handler-name question, the fast-join byte-offset plumb-through.
2. **Recovery wiring (Phase 2):** `0001:A9` designed the affine epoch/offset reset for catastrophic stream loss but explicitly left the offset-aware append and the agent-object reconcile handlers unbuilt (`allowEpochReset:false` until wired). This is the last unimplemented piece of the D3 projection story.
3. **Harness/interface improvements (Phase 3):** exec AbortSignal, multi-fold summarization, observability completion — each was skipped in 0001 precisely because it touched a frozen or contended surface mid-build.
4. **Live validation (Phase 4):** the build's acceptance suites (conformance 5 live scenarios, chaos 5 live faults, CASDK live smoke) all skip without `TEASPILL_STACK_URL`/`TEASPILL_CHAOS`/`TEASPILL_CASDK_LIVE`. v1 is not truly "accepted" until they run green against a real stack.
5. **Ops polish (Phase 5):** key-mint ergonomics, docker adapter prod hardening, backup lossy-combo regression, closing docs sweep.

## 2. Inherited constraints

- **Binding:** `0001:D1–D8` and `0001:A1–A10` (see `work/plans/0001-build-v1/DECISIONS.md`). Highlights that bite here: A1 (seq 0-based gapless), A4 (explicitCancellation, journal ≤~1MiB, pinned SDK), A5 (schema FROZEN v1 — additive-only; breaking ⇒ bump `v`), A6 (producer reality: per-request Producer-Seq, debounced dedup, head_seq is a floor), A9 (affine offset design this plan implements), A10 (resurrection/onWake contracts).
- **Frozen surfaces:** `packages/schema` events/deltas v1; `packages/harness-native/src/interface.ts` (Harness/ToolContext/WorkspaceClient). Changes must be additive and default-preserving. Anything else ⇒ HALT + amendment in this plan's DECISIONS.md.
- **Version pins stay:** Restate SDK 1.16.2, `@durable-streams/client@0.2.6` (server :0.1.4), `@anthropic-ai/claude-agent-sdk@0.3.211`, `@mariozechner/pi-ai@0.73.1`, TS <6.1.0. Bumps are out of scope for this plan.
- **Repo hygiene:** `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint` green before any group commits; live-infra tests skip-guard without the stack.
- Read `0001:WORKLOG` entries for any package you touch — the surprises recorded there (e.g. A6 producer semantics, distroless durable-streams image, IncomingMessage 'close' behavior) are load-bearing.

## 3. Task breakdown

Legend — **Model size**: S = mechanical/boilerplate, well-specified, low blast radius. M = standard implementation requiring local judgment. L = design-heavy, cross-cutting, high blast radius. **Critical** = failure blocks or corrupts other phases. Model per tier: see the dispatch profile in `work/README.md` (vendor-neutral).

### Phase 1 — Debt & seam cleanups

**T1.1 — Promote addressing helpers to `@teaspill/schema`** · **S**
The addressing regex/derivation fns (from `docs/addressing.md`) are ported in BOTH `packages/gateway` and `packages/frontend-sdk/src/actions.ts` (0001:T1.2 + T5.2 carry-forward). Move one canonical copy into `@teaspill/schema`, re-export/consume from both, delete the duplicates. Keep behavior byte-identical (gateway 72 + frontend-sdk 51 tests must stay green unmodified except imports).
*Anticipate:* schema is the frozen package — these fns are additive module surface, not event-schema change; no freeze concern, but do not touch events.ts/deltas.ts.

**T1.2 — `packages/agents-sdk` README** · **S**
The only package without a README (guide lives in `docs/agents-sdk.md`). Write a package-level README: defineAgent surface, harness selection (`native`/`claudeAgentSdk`), onWake contract (`0001:A10`), registration, revision rules — linking to docs/ rather than duplicating.

**T1.3 — Export coordination test utilities** · **S**
`FakeTimelineServer` and `validateProducer` (faithful ports of the rust server's producer logic) live unexported in `packages/coordination`; `@teaspill/conformance` re-ported `validateProducer` locally (0001:T6.3 noted this as a promotion candidate). Export them from coordination under a `/testing` subpath export, delete the conformance re-port, point chaos/conformance at the canonical ones.
*Anticipate:* keep them out of the package main entry (no accidental prod dependency); a `./testing` exports-map entry is the boring answer.

**T1.4 — Handler-name grammar: settle dotted names** · **S/M**
0001:T4.1 shipped executor handlers as `fsRead` (not `fs.read`) because the dot-in-handler-name grammar was never verified in the T2.0 spike; the gateway `/api` name-map decides public spelling. Verify against the running Restate 1.7.2 (extend `references/restate-spike` — a 20-line probe) whether dotted handler names are legal. Then either (a) bless camelCase as the permanent spelling and record it in `docs/addressing.md` + a DECISIONS amendment, or (b) if dots are legal AND worth it, still keep camelCase internally and confirm the gateway name-map covers the public spelling. Either way: one authoritative name-map location in gateway, documented.
*Anticipate:* this is a decision-recording task, not a rename crusade — do NOT rename shipped handlers unless the probe reveals an actual problem.

**T1.5 — Fast-join byte offset: plumb `snapshot_stream_offset` to the reader** · **M**
0001:T8.1 added catalog column `snapshot_stream_offset` (opaque durable-streams byte offset of the latest snapshot record) but `frontend-sdk/catalog.ts` never surfaces it, so `createAgentTimeline` still scans from offset 0 (correct, not cheap). Surface the column through the catalog shape/hook, feed it into `fromSnapshot.offset`, and make the timeline reader seek there. Extend the reducer conformance tests: joining at a byte offset that lands *before* the snapshot record (offset captured early per 0001:T8.1) must still resolve via the seq floor — already the reducer's rule (0001:A6#5, A7), now exercised end-to-end. Verify against the real `:0.1.4` image (skip-guarded) like T5.2's live smoke.
*Anticipate:* the offset is an opaque TEXT token, not a number — never arithmetic on it. NULL column (pre-0002 rows, never-snapshotted entities) ⇒ scan-from-0 fallback stays.

### Phase 2 — Recovery wiring (`0001:A9` follow-up)

**T2.1 — Affine offset append + agent-object reconcile handlers** · **L** · critical
Implement the epoch-reset path A9 designed. In `packages/coordination/projection-outbox.ts`: generalize the append to `Producer-Seq = canonicalSeq − outboxProducerSeqOffset`, persisting `outboxProducerSeqOffset` beside `outboxProducerEpoch` in K/V (normal op: offset 0 / epoch 0 ⇒ identity, A1 unchanged). Implement the catastrophic reset step: at canonical seq N on a lost/fenced/closed stream ⇒ epoch E+1, offset N, recovery `state_snapshot(recovery, historyHole:true)` appends at Producer-Seq 0 under the new epoch; canonical seq stays gapless. On the agent object: add `reconcileProbe` (shared), `reconcileFlush` (exclusive), `reconcileRecovery` (exclusive) handlers so `createRestateEntityReconcileClient` goes live. Flip the `allowEpochReset` gate default only after the property suite covers the reset. Extend 0001:T2.2's fast-check property suites: arbitrary crash schedules across reset boundaries must preserve exactly-once/in-order/gapless + reader seq-dedup.
*Anticipate:* this file is the D3 crown jewel — same rigor as 0001 Gate 3. The fake server (`validateProducer` port, now exported per T1.3) must model epoch fencing (lower epoch ⇒ 403) and new-epoch-starts-at-0 exactly as `handlers.rs` does. Reset is REQUESTED by the reconciler but EXECUTED by the agent object (single-writer owns K/V) — keep that split. Readers are canonical-seq based (A6#2): epoch+offset must stay invisible above the outbox; assert that in tests.

**T2.2 — Reconciler live loop + alert wiring** · **M**
With T2.1's handlers live: wire the reconciler's `createRestateEntityReconcileClient` to the real shared-probe/flush/recovery handlers; schedule the reconciler partition objects from somewhere real (compose-adjacent bootstrap or CLI `teaspill dev`); route `AlertSink` unrecoverable alerts into the 0001:T8.2 metrics (`recordDrift` already exists) and a log line that operators will actually see. Live-gated integration test: induce catalog lag + stuck outbox against the real stack, watch the reconciler repair both (skip-guarded).
*Anticipate:* probe is a shared handler on a possibly-busy object — confirm it stays cheap (~21ms, SPIKE §a) and never blocks behind an exclusive wake. Don't schedule reconcilers by default in unit-test contexts (generation-guard pattern from cron applies).

### Phase 3 — Harness & interface improvements

**T3.1 — Exec abort: `AbortSignal` through `WorkspaceClient.exec`** · **M**
0001:T4.3/T7.2 noted `WorkspaceClient.exec` has no AbortSignal, so `ctx.signal` isn't forwarded to long execs (abort today only via the workspace `kill` handler). Add an optional `signal?: AbortSignal` to the exec options (additive, default-preserving — frozen-interface rule) and plumb it: harness tool `bash` forwards `toolCtx.signal`; the executor host maps an aborted client signal onto the existing kill path (adapter kill-tree → awakeable `killed`). Both harnesses benefit; CASDK's interrupt already aborts the SDK — this closes the gap down to the running process.
*Anticipate:* the signal crosses a Restate ingress boundary — it cannot literally travel; the plumbing is "on abort, fire the kill handler with the current execId" client-side. Make that explicit in the WorkspaceClient docs so nobody assumes in-process signal magic. Idempotent with the 3-layer kill safety from 0001:T4.1.

**T3.2 — `commitEvents` returns seqs; multi-fold summarization** · **M**
0001:T3.2 limited the pi harness to ONE summarization fold per run because `commitEvents` doesn't return the allocated seqs (`replacesThroughSeq` needs the last context-bearing canonical seq). Make the outbox commit seam return the finalized events (with seqs) — additive change to the seam contract in `agent-seams.ts` — and lift the one-fold-per-run limit in `pi-harness.ts`. Test: a run that exceeds budget twice folds twice, `replacesThroughSeq` correct both times, context assembly honors the latest fold (`selectContextEvents` latest-wins already).
*Anticipate:* stage() already produces `TimelineEvent[]` — the return value exists internally; this is threading, not redesign. Don't let the harness *retain* full committed events (journal budget, A4) — it needs seqs and types only.

**T3.3 — Observability completion** · **M**
Close 0001:T8.2's open items: (a) per-tool-call spans inside both harnesses (harness-native step loop + harness-casdk capture; child of `harness.run`, tagged toolName/toolUseId/outcome); (b) agent→executor traceparent injection at the harness-native tool client (executor already extracts); (c) gauge cardinality — convert `outbox_depth`/`projection_lag`/`workspace_pool` to ObservableGauge over a resident registry instead of per-observation records.
*Anticipate:* keep the zero-behavior-change/no-op-by-default stance; injector lives in the harness-native tool client that T8.2 called off-limits mid-build — it isn't anymore, but keep the envelope-not-canonical-event rule (A5 frozen) for trace context.

### Phase 4 — Live validation (the centerpiece)

**T4.1 — Reference deployment: example agents + compose overlay** · **M/L**
New `examples/` workspace package (or `packages/reference-deployment` — executor decides, record in WORKLOG): a deployable agent-loop service exposing (a) the deterministic onWake-only conformance agents per 0001:T6.3's documented contract (no LLM — A10 made these possible), (b) one real pi-harness demo agent and one CASDK demo agent (env-gated on API keys), plus an executor-host service with the docker adapter. A `docker-compose.overlay.yml` (or profile) adding both services to the stack with correct networking (`host.docker.internal` stance from `docs/self-hosting-networking.md`), registered via `teaspill dev`. Fill the chaos suite's agent-loop/executor compose service-name placeholders (0001:T9.1 open item).
*Anticipate:* this doubles as the missing "getting started" example — write it as one (it will be copied by every future user of the platform). The register-before-up race is already solved in the CLI (waitForHealthy + backoff) — use it, don't reinvent. Real ingress tool clients + `listChildren` real impl are deployment-side seams (0001:T6.2 open) — THIS is the deployment where they finally get real implementations.

**T4.2 — Live conformance run** · **L** · critical (gate)
Bring up the full stack + T4.1 overlay and run all 5 conformance scenarios live (`TEASPILL_STACK_URL`): spawn-respond, parallel-fanout, crash-resume, projection-continuity, workspace-exec-durability. Fix what breaks — with license to touch any package, serializing with care (this group runs solo). Every fix lands with a regression test at the lowest layer that can express it. Also flip on the live paths that were never exercised: real interrupt via `ctx.cancel` (@experimental API, A4 said "conformance-test this seam"), idle auto-archive → resurrection round-trip live, steer push/drain mid-run.
*Anticipate:* first-run failures will cluster at the never-live seams: real ingress tool clients, `explicitCancellation` interrupt, delayed-send timing, resurrection. Budget for surprises in Restate invocation retention/idempotency windows (A4#4: expiry is lazy — a floor). Record every live-behavior surprise in WORKLOG with the same rigor 0001 recorded A6 — this task is where reality audits the build.

**T4.3 — Live chaos run** · **L**
With conformance green: `TEASPILL_CHAOS=1` against the same stack — the 5 faults (agent-loop kill mid-LLM, executor kill mid-exec, streams kill, restate kill, gateway restart mid-long-poll), each asserting its mapped invariant via the conformance assert fns. Includes the A6#2 debounced-producer-dedup window (server crash readmitting an acked append ⇒ reader seq-dedup covers it) — chaos is where that window is actually provoked. Fix breaks as in T4.2.
*Anticipate:* `ComposeController` shells to `docker compose kill/stop/up -d` — flaky timing is the enemy; prefer polling waitHealthy over sleeps. If a fault reveals an invariant hole (not a bug), that is amendment territory — HALT per protocol.

**T4.4 — Soaks + model-ergonomics tuning** · **M**
(a) CASDK live smoke (`TEASPILL_CASDK_LIVE=1`) plus a longer soak: multi-wake warm-resume chains, interrupt-mid-tool, steer injection — watch for session-format drift against the pinned 0.3.211 goldens. (b) pi-ai provider soak: exercise the non-Anthropic providers enough to decide the `BUFFERED_PROVIDERS` set (0001:T3.2 left it empty pending soak). (c) The tool-description tuning pass 0001:T3.3 budgeted: run real transcripts through the platform tools, fix where models misuse the async spawn/wake model, keep the teaching-substring tests in sync.
*Anticipate:* soaks burn real tokens — keep runs small and targeted; capture transcripts into `work/plans/0002-follow-ups/notes/` for the tuning evidence trail.

### Phase 5 — Ops & product polish

**T5.1 — API key minting ergonomics** · **S/M**
0001:T1.2 left key-mint ergonomics to the CLI. Add `teaspill keys create|revoke|ls`: generates a 256-bit random key, stores `sha256` hash via `@teaspill/catalog` (`api_keys` table exists), prints the `tsp_` token once. Needs a DB connection (operator context), not a gateway route — document that choice (gateway has no admin-auth tier; adding one is out of scope).
*Anticipate:* never log/store the plaintext; revoke = set `revoked_at`, gateway already checks it.

**T5.2 — Docker adapter prod hardening** · **M**
0001:T4.2 open items: pin the default image by digest (alpine:3.20@sha256:…), add a network-isolation option (`network: none|bridge|<custom>` per workspace config, default documented), and revisit the socket-mount tradeoff note for prod (document, don't build a DinD alternative).
*Anticipate:* keep the adapter interface unchanged — these are config surface + defaults, not new seams.

**T5.3 — Backup lossy-combo regression** · **S/M**
0001:T8.3 open: no automated regression for the documented restore matrix. Add a conformance-style scenario (live-gated): restore catalog+streams WITHOUT Restate ⇒ active entity's next message throws the LOUD TerminalError ("has no live state"), archived entity resurrects fine. Script-drive `scripts/backup.sh`/`restore.sh` in the test.
*Anticipate:* slow test — tag it out of the default suite (chaos-tier gating, `TEASPILL_CHAOS=1`).

**T5.4 — Docs refresh sweep** · **S/M**
After all above: sweep `docs/` + package READMEs for staleness (the 0001:T9.2 pass predates this entire plan). Specifically: addressing.md (T1.4 verdict), frontend-sdk.md (T1.5 fast-join), self-hosting.md (T4.1 overlay + getting-started), auth.md (T5.1 keys CLI), agents-sdk README (T1.2 may need touch-ups after T4.1's real example). Update `docs/README.md` index.
*Anticipate:* cite source for every claim like T9.2 did; fix, don't rewrite.

## 4. Sequencing & gates

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 (T5.4 last)
   │            │                       ▲
   │            └── T2.1 property tests ┤ (gate Gate 1)
   └── T1.3 feeds T2.1's fake server    │
T4.1 ──► T4.2 (gate Gate 2) ──► T4.3 ──► T4.4
T5.1/T5.2/T5.3 float into earlier groups as fillers (disjoint packages)
```

Hard gates:
1. **Gate 1:** T2.1's extended property suite green (incl. epoch-reset schedules) before T2.2 wires it live and before T4.3 provokes it. Same class as 0001 Gate 3.
2. **Gate 2:** T4.2 live conformance green before T4.3 chaos runs. Chaos on a stack that doesn't pass conformance produces noise, not findings.
3. **Frozen-surface rule** (standing): any non-additive change to schema v1 or the harness interface ⇒ HALT + amendment.

## 5. Task/model-size summary

| Task | Title | Size | Critical |
|---|---|---|---|
| T1.1 | Addressing helpers → schema | S | |
| T1.2 | agents-sdk README | S | |
| T1.3 | Export coordination test utils | S | |
| T1.4 | Handler-name grammar verdict | S/M | |
| T1.5 | Fast-join byte-offset plumb | M | |
| T2.1 | Affine offset append + reconcile handlers | L | ✔ (gate Gate 1) |
| T2.2 | Reconciler live loop + alerts | M | |
| T3.1 | Exec AbortSignal | M | |
| T3.2 | commitEvents seqs + multi-fold summarization | M | |
| T3.3 | Observability completion | M | |
| T4.1 | Reference deployment + compose overlay | M/L | ✔ |
| T4.2 | Live conformance run | L | ✔ (gate Gate 2) |
| T4.3 | Live chaos run | L | ✔ |
| T4.4 | Soaks + tool-description tuning | M | |
| T5.1 | Key minting CLI | S/M | |
| T5.2 | Docker adapter hardening | M | |
| T5.3 | Backup lossy-combo regression | S/M | |
| T5.4 | Docs refresh sweep | S/M | |

## 6. Orchestration

Executed by a main coordinating session dispatching one subagent per task. Protocol: `work/README.md` (ledger discipline, scoped references, plan-level conflict rule). Kickoff for a fresh session: **"Read work/plans/0002-follow-ups/PLAN.md and start work."**

Per-plan specifics:

- Every subagent receives: this document; its task id; this plan's DECISIONS.md + WORKLOG.md; and the 0001 WORKLOG entries for the packages it touches (pointers, not the whole file, when context is tight). For M/L tasks, call out the specific inherited decisions (`0001:D…/A…`) the task implements.
- Subagents return their WORKLOG entries; the main session merges, reviews, and commits each group atomically with ledger updates.
- Definition of done: code + passing tests in CI + WORKLOG entry; L tasks leave a design note in the package README. Live-gated tests must skip cleanly without the stack.
- Integration review between groups (diffs + WORKLOG + full suite); never pipeline groups. Gates are absolute. Prefer sequential under doubt.
- Model per tier: dispatch profile in `work/README.md` (swap it to use any model family).

### Dispatch groups (≤3 parallel; groups strictly sequential)

| Group | Parallel tasks | Rationale / dependencies satisfied |
|---|---|---|
| G1 | T1.1 · T1.2 · T1.3 | Mechanical cleanups, disjoint packages (schema+consumers / agents-sdk docs / coordination+conformance). |
| G2 | T1.4 · T1.5 · T5.2 | Gateway name-map ∥ frontend-sdk+catalog ∥ executor hardening — disjoint. |
| G3 | T2.1 · T5.1 | The critical outbox L gets a quiet group; keys CLI (cli+catalog) is disjoint filler. Gate Gate 1 closes here. |
| G4 | T2.2 · T3.1 · T5.3 | Reconciler wiring (coordination, post-Gate 1) ∥ exec signal (executor+harness-native) ∥ backup regression (conformance+scripts). |
| G5 | T3.2 · T4.1 | commitEvents seam (coordination+harness-native) ∥ reference deployment (new package + compose). Kept at 2 — both integrative. |
| G6 | T3.3 | Observability completion alone — it touches harness-native/harness-casdk/executor right after G5 edited two of them; serialize to avoid contention. |
| G7 | T4.2 | Gate Gate 2, solo with fix-anything license. The reality audit. |
| G8 | T4.3 · T4.4 | Chaos ∥ soaks/tuning — chaos drives the stack, soaks drive the harnesses; coordinate stack usage (same live stack, different services), serialize if they interfere. |
| G9 | T5.4 | Closing docs sweep once everything has landed. |
