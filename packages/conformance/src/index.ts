/**
 * @teaspill/conformance — the conformance kit (0001:T6.3).
 *
 * A reusable acceptance harness: named scenarios, each asserting one 0001:D2/0001:D3
 * invariant of a running teaspill stack. Offline versions (against the real
 * coordination / executor primitives + faithful fakes) run in CI with no
 * stack; the true end-to-end versions run behind `TEASPILL_STACK_URL`. See
 * README.md for the run recipe and the conformance-agent contract.
 *
 * This kit is ALSO the base 0001:T9.1's chaos suite builds on: it imports the
 * `SCENARIOS` registry (metadata + pure `check`), the reusable invariant
 * functions, and the live driver, then re-asserts the same invariants after
 * injecting faults ("assert the invariant, not just no-crash", PLAN 0001:T9.1).
 */

export const packageName = "@teaspill/conformance" as const;

// Scenario registry (metadata + pure `check`) — the 0001:T9.1 entry point.
export * from "./scenarios.js";

// Reusable invariant checks (pure, over TimelineEvent[]).
export * from "./invariants.js";

// Types (ConformanceScenario, InvariantResult, …) + assertion adapters.
export * from "./types.js";

// Live-stack driver (env-gated) — drive via actions, observe via the timeline.
export * from "./live.js";

// The parallel fan-out offline runner — the permanent upstream regression.
export * from "./parallel-fanout.js";

// Offline support fakes (also handy for chaos harnesses that want them).
export { MemoryWorld, type CapturedSend } from "./support/memory-ctx.js";
export {
  FakeStreamsServer,
  SimulatedNetworkError,
  type PlannedFault,
} from "./support/fake-streams.js";
// `validateProducer` is the canonical port (0002:T1.3), promoted out of
// coordination's own property-test fake — re-exported here (not re-ported)
// so existing conformance/chaos imports keep working.
export { validateProducer } from "@teaspill/coordination/testing";
export { ManualExecAdapter } from "./support/fake-adapter.js";
