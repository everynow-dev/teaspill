# 0002 — Decisions ledger

## Inherited (binding, not copied)

- `0001:D1–D8` — core architecture. See `work/plans/0001-build-v1/DECISIONS.md`.
- `0001:A1–A10` — all accepted amendments, notably: A1 (seq 0-based gapless), A4 (cancellation + journal budgets, pinned Restate SDK), A5 (canonical schema FROZEN v1, additive-only), A6 (durable-streams producer reality), A7 (retention + snapshot cadence), A9 (reconciler epoch/offset stance — T2.1 implements its follow-up), A10 (resurrection, idle auto-archive, onWake contract).
- License verdict `0001:T0.4` (R1 PROCEED) and its standing constraint: never expose raw Restate registration in a multi-tenant hosted mode.
- Version pins: Restate SDK 1.16.2, `@durable-streams/client@0.2.6` / server :0.1.4, `@anthropic-ai/claude-agent-sdk@0.3.211`, `@mariozechner/pi-ai@0.73.1`, TS <6.1.0.

Superseding an inherited decision requires an amendment below naming the qualified id it supersedes.

---

## Amendments log

### 0002:A1 — Restate handler names may NOT contain a dot; camelCase FS handlers are permanent (T1.4)

Probed against live Restate 1.7.2 (`references/restate-spike/src/dotted-handler-probe.ts`, ephemeral — spike dir is gitignored): handler names are validated at admin registration/discovery against `^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9_]*$` — no `.`, `-`, or `/`. A handler named `fs.read` is rejected (HTTP 500) even though the SDK constructs it silently. Service names are NOT so restricted: `agent.<type>` (dotted) registers fine (HTTP 201), confirming 0001:T2.0 and closing addressing.md open question §10.5.

Decision: the executor/workspace FS handlers (`fsRead`, `fsWrite`, `fsMkdir`, `fsRm`, `fsStat`, `fsLs`) keep camelCase as their PERMANENT internal Restate handler spelling. Not a rename crusade — nothing changes; this records the grammar so the question is never reopened. Any model-/HTTP-facing "public" spelling is decided in the gateway `/api` name-map (`AGENT_HANDLERS` in packages/gateway/src/routes/api.ts) or the harness tool layer, decoupled from the Restate handler name.

Binding. Evidence and detail: docs/addressing.md §6.1.

### 0002:A2 — Resurrection carries producer epoch/offset (refines 0001:A10) (T2.1)

0001:A10 was written in the constant-epoch world and stated the producer epoch is 0 at resurrection. With the T2.1 epoch-reset path built, an entity that suffers a catastrophic reset (epoch E+1, offset N) and then idle-archives would, under A10's literal wording, resurrect at epoch 0 and be **fenced forever** by the server (lower epoch ⇒ 403).

Refinement: `ArchiveSnapshotState` gains additive optional `producerEpoch?`/`producerSeqOffset?` (coordination-internal shape, NOT schema v1 — default-preserving: absent ⇒ 0 ⇒ pre-0002 snapshots byte-identical, A10 unchanged for never-reset entities). `applyArchive` persists them only when non-zero; `resurrectFromCatalog` restores both (`?? 0`). A reset entity thus resurrects at its bumped epoch/offset and its next flush is accepted, not fenced.

This supersedes only the "epoch stays 0 at resurrection" clause of 0001:A10; the rest of A10 (idle auto-archive, onWake contract) stands. Not a schema change (frozen v1 untouched). Binding.

Note (not an amendment): flipping `allowEpochReset` default false→true implements A9's "once the append path exists" condition. A9's "ops opts in" nuance is preserved as an opt-OUT (`allowEpochReset:false` restores alert-only), plus an execution-time re-verify-flush guard so a spurious request cannot fire a destructive reset. Recorded in WORKLOG, no decision superseded.

### 0002:A3 — Interrupt wind-down I/O aborts on the ATTEMPT signal only; the armed interrupt-abort must be a raced, single-await-point promise (refines 0001:A4) (T4.2)

Live conformance of the A4 cancellation seam (Restate 1.7.2 / SDK 1.16.2, pinned) surfaced three realities:
1. **SDK promises are lazy** — polled only while awaited. An unawaited `void cancellation().map(abort)` is never polled, so a fire-and-forget arm silently does nothing (the armed interrupt-abort never fired on a real stack).
2. **Eagerly polling** the dangling cancellation promise for the handler's lifetime breaks journal determinism — live Restate rejects replay with `(570) code-path mismatch`. The only safe shape is the SPIKE-verified race awaited at a single point — implemented as `racedRun`: once armed, every journaled `ctx.run` step is raced against the cancellation signal; cancellation winning fires the (idempotent) abort and **continues awaiting the same journaled step** (non-throwing wind-down, no double-authored boundary); once aborted, later steps skip the race (deterministic on replay).
3. A4's "every long closure must abort on `AbortSignal.any([interruptSignal, attemptCompletedSignal])`" is **refined**: post-interrupt wind-down I/O — specifically the outbox flush that commits `control(interrupt)` + `run_finished(interrupted)` — must abort on the **attempt-completed signal ONLY** (`AgentRuntimeCtx.attemptAbortSignal`, additive; falls back to `runAbortSignal` when absent, so pre-0002 fakes are unchanged), never the interrupt branch. Aborting the cleanup on interrupt is self-defeating (the flush IS the interrupt's durable record) and wedged the wake in a retry loop live. Zombie discipline is preserved: attempt retirement still aborts everything.

Supersedes only the "every long closure" clause's application to interrupt wind-down I/O; the rest of 0001:A4 stands. Serves A4's own stated goal ("an interrupt leaves state consistent"). Binding. Detail + live evidence: this plan's WORKLOG T4.2 entry.
