/**
 * The conformance scenario registry (0001:T6.3).
 *
 * `SCENARIOS` is the single source of truth the whole kit — CI offline runs,
 * the live end-to-end runs, and 0001:T9.1's chaos suite — indexes by `id`. Each
 * entry is pure metadata plus a pure `check` that binds the reusable invariant
 * functions (invariants.ts) to that scenario's expectation. 0001:T9.1 imports this
 * array, drives the live stack, injects a fault, and re-runs `check` on the
 * observed timeline — "assert the invariant, not just no-crash" (PLAN 0001:T9.1).
 *
 * Each scenario maps to the 0001:D2/0001:D3 invariant it guards and the PLAN §4 R-risk it
 * exercises. See README.md for how to run offline vs live.
 */

import {
  assertAllChildFinished,
  assertExactlyOnceGapless,
  assertResponded,
  assertSeqGapless,
  assertStructural,
} from "./invariants.js";
import { combineInvariants, type ConformanceScenario } from "./types.js";

export const SPAWN_RESPOND: ConformanceScenario = {
  id: "spawn-respond",
  title: "spawn → respond",
  invariant:
    "A spawned agent, sent a message, projects an assistant `message` and a successful `run_finished` on its timeline.",
  asserts: ["D2", "D1", "A5"],
  risks: ["R5"],
  mode: "live",
  check: (events, expect) =>
    combineInvariants(
      assertStructural(events),
      assertResponded(events, { ...(expect?.replyIncludes !== undefined && { replyIncludes: expect.replyIncludes }) }),
    ),
};

export const PARALLEL_FANOUT: ConformanceScenario = {
  id: "parallel-fanout",
  title: "parallel fan-out (PERMANENT REGRESSION)",
  invariant:
    "A parent spawning N children in one wake receives ALL N `child_finished` deliveries (none dropped, none double-counted) — the upstream dropped-parent-wake bug.",
  asserts: ["D2", "A1"],
  risks: ["R5"],
  mode: "both",
  check: (events, expect) => {
    const childIds = expect?.childIds ?? [];
    return combineInvariants(
      assertStructural(events),
      assertSeqGapless(events),
      assertAllChildFinished(events, childIds),
    );
  },
};

export const CRASH_RESUME: ConformanceScenario = {
  id: "crash-resume",
  title: "crash-mid-run resume",
  invariant:
    "A run interrupted between append and trim resumes with no duplicate events: the projected timeline is exactly-once and seq-gapless (0001:A1/0001:D3).",
  asserts: ["A1", "D3", "A6"],
  risks: ["R4"],
  mode: "both",
  check: (events, expect) =>
    combineInvariants(
      assertStructural(events),
      assertExactlyOnceGapless(events, {
        ...(expect?.expectedFirstSeq !== undefined && { expectedFirstSeq: expect.expectedFirstSeq }),
      }),
    ),
};

export const PROJECTION_CONTINUITY: ConformanceScenario = {
  id: "projection-continuity",
  title: "projection continuity through a streams-server restart",
  invariant:
    "Across a streams-server restart the outbox replays from the first-unconfirmed seq; the reader (deduped by canonical seq) sees a gapless timeline with zero seq gaps (0001:A6/0001:D3).",
  asserts: ["A6", "A1", "D3"],
  risks: ["R5"],
  mode: "both",
  check: (events, expect) =>
    combineInvariants(
      assertStructural(events),
      // `events` here is the reader's seq-deduped view (0001:A6 duplicate records
      // already removed) — so it must be exactly-once AND gapless.
      assertExactlyOnceGapless(events, {
        ...(expect?.expectedFirstSeq !== undefined && { expectedFirstSeq: expect.expectedFirstSeq }),
      }),
    ),
};

export const WORKSPACE_EXEC_DURABILITY: ConformanceScenario = {
  id: "workspace-exec-durability",
  title: "workspace exec survives agent-loop restart",
  invariant:
    "A long exec's awaitable resolves after the agent-loop replica restarts: the exec lives in the executor host plane and its awakeable is resolved exactly-once regardless of agent-loop re-dispatch (D4/T4.1).",
  asserts: ["D4"],
  risks: ["R4"],
  mode: "both",
  // This scenario's invariant is over awakeable resolution, not a timeline —
  // it is asserted directly in exec-durability.test.ts / the live driver.
  // `check` validates any run_finished the wrapping run emits stays consistent.
  check: (events) => assertStructural(events),
};

/** Every conformance scenario, in run order. Keyed by `id` for 0001:T9.1 reuse. */
export const SCENARIOS: readonly ConformanceScenario[] = [
  SPAWN_RESPOND,
  PARALLEL_FANOUT,
  CRASH_RESUME,
  PROJECTION_CONTINUITY,
  WORKSPACE_EXEC_DURABILITY,
];

/** Look up a scenario by id (throws on unknown — ids are a stable contract). */
export function scenarioById(id: string): ConformanceScenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown conformance scenario ${JSON.stringify(id)}`);
  return found;
}
