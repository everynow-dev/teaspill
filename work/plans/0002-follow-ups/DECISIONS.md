# 0002 — Decisions ledger

## Inherited (binding, not copied)

- `0001:D1–D8` — core architecture. See `work/plans/0001-build-v1/DECISIONS.md`.
- `0001:A1–A10` — all accepted amendments, notably: A1 (seq 0-based gapless), A4 (cancellation + journal budgets, pinned Restate SDK), A5 (canonical schema FROZEN v1, additive-only), A6 (durable-streams producer reality), A7 (retention + snapshot cadence), A9 (reconciler epoch/offset stance — T2.1 implements its follow-up), A10 (resurrection, idle auto-archive, onWake contract).
- License verdict `0001:T0.4` (R1 PROCEED) and its standing constraint: never expose raw Restate registration in a multi-tenant hosted mode.
- Version pins: Restate SDK 1.16.2, `@durable-streams/client@0.2.6` / server :0.1.4, `@anthropic-ai/claude-agent-sdk@0.3.211`, `@mariozechner/pi-ai@0.73.1`, TS <6.1.0.

Superseding an inherited decision requires an amendment below naming the qualified id it supersedes.

---

## Amendments log

(none yet)
