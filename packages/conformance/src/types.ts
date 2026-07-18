/**
 * Conformance kit (0001:T6.3) — shared vocabulary.
 *
 * A "scenario" is a named acceptance test that asserts ONE 0001:D2/0001:D3 invariant of
 * a running teaspill stack. Every scenario carries:
 *   - a one-sentence `invariant` statement,
 *   - the DECISIONS/PLAN anchors it `asserts` (0001:A1, 0001:A3, 0001:D2, 0001:D3, …),
 *   - the PLAN §4 R-`risks` it maps to,
 *   - a `mode` (does it run offline in CI, live behind the env gate, or both),
 *   - a pure `check(...)` that decides pass/fail over an observed timeline.
 *
 * The `check` functions are the load-bearing, reusable part: the offline CI
 * runs, the live end-to-end runs, AND 0001:T9.1's chaos suite (assert-the-invariant-
 * after-fault) all call the SAME check. That is why they take a plain
 * `readonly TimelineEvent[]` (whatever produced it) plus scenario-specific
 * expectations, and return a structured `InvariantResult` rather than throwing
 * — a caller injecting faults wants to inspect violations, not catch.
 */

import type { TimelineEvent } from "@teaspill/schema";

/** Where a scenario's invariant is genuinely exercised. */
export type ScenarioMode =
  /** Runs in CI with no stack (against real primitives + fakes). */
  | "offline"
  /** Needs a live stack (`TEASPILL_STACK_URL`); skipped in CI. */
  | "live"
  /** Both: an offline version runs in CI and a true e2e runs behind the gate. */
  | "both";

/** The outcome of an invariant check. Never throws — violations are data. */
export interface InvariantResult {
  ok: boolean;
  /** Human-readable violations (empty ⇒ ok). */
  violations: string[];
  /** Optional structured facts (counts, seqs) for reporting/debugging. */
  facts?: Record<string, unknown>;
}

/**
 * Everything a scenario's `check` may need beyond the observed events. Each
 * field is optional; a given scenario reads only what it declares in its
 * docstring. Kept as one open bag so all checks share a single call shape
 * (`check(events, expect)`) — convenient for 0001:T9.1's generic driver.
 */
export interface ScenarioExpectation {
  /** spawn→respond: substring expected in the assistant reply text. */
  replyIncludes?: string;
  /** parallel fan-out: the exact child entity urls that must all report back. */
  childIds?: readonly string[];
  /** crash-resume / continuity: the seq the contiguous timeline must start at. */
  expectedFirstSeq?: number;
  /** continuity: number of duplicate stream records the reader must have absorbed. */
  minDuplicatesDropped?: number;
}

/**
 * A conformance scenario definition. This object is pure metadata + a pure
 * `check`; the drivers that PRODUCE the observed events (offline runners, the
 * live e2e, chaos) live in the scenario's own module and in `live.ts`.
 */
export interface ConformanceScenario {
  /** Stable id (kebab-case) — chaos tests and reports key off this. */
  id: string;
  title: string;
  /** One-sentence statement of the invariant this scenario guarantees. */
  invariant: string;
  /** DECISIONS/PLAN anchors asserted (e.g. ["0001:A1", "0001:A3", "0001:D3"]). */
  asserts: readonly string[];
  /** PLAN §4 cross-cutting R-risks this scenario maps to. */
  risks: readonly string[];
  mode: ScenarioMode;
  /**
   * Decide pass/fail over the SUBJECT entity's observed timeline events
   * (the parent, for fan-out; the responder, for spawn→respond). Pure.
   */
  check(events: readonly TimelineEvent[], expect?: ScenarioExpectation): InvariantResult;
}

/** Combine sub-results into one (AND over `ok`, concat violations/facts). */
export function combineInvariants(
  ...results: readonly InvariantResult[]
): InvariantResult {
  const violations = results.flatMap((r) => r.violations);
  const facts = Object.assign({}, ...results.map((r) => r.facts ?? {}));
  return { ok: violations.length === 0, violations, facts };
}

/** Assert-style adapter for tests: throw with all violations if not ok. */
export function expectInvariant(result: InvariantResult): void {
  if (!result.ok) {
    throw new Error(
      `invariant violated:\n  - ${result.violations.join("\n  - ")}` +
        (result.facts ? `\nfacts: ${JSON.stringify(result.facts)}` : ""),
    );
  }
}

export type { TimelineEvent };
