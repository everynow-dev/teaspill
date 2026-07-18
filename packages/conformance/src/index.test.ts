/**
 * Registry sanity — the SCENARIOS array is the stable contract 0001:T9.1 keys off,
 * so guard its shape: unique ids, a stated invariant, D/A anchors, and a mode.
 */

import { describe, expect, it } from "vitest";
import {
  SCENARIOS,
  packageName,
  scenarioById,
  combineInvariants,
  assertSeqGapless,
} from "./index.js";
import { LIVE_TEST_TIMEOUT_MARGIN_MS, liveTestTimeout, readStackConfig } from "./live.js";

describe("conformance scenario registry", () => {
  it("exposes the 0001:T6.3 scenarios plus the 0002:T5.3 backup regression, with unique ids", () => {
    expect(SCENARIOS.map((s) => s.id)).toStrictEqual([
      "spawn-respond",
      "parallel-fanout",
      "crash-resume",
      "projection-continuity",
      "workspace-exec-durability",
      "backup-lossy-restore",
    ]);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("every scenario declares an invariant, D/A anchors, risks, and a mode", () => {
    for (const s of SCENARIOS) {
      expect(s.invariant.length).toBeGreaterThan(10);
      expect(s.asserts.length).toBeGreaterThan(0);
      expect(s.risks.length).toBeGreaterThan(0);
      expect(["offline", "live", "both"]).toContain(s.mode);
      expect(typeof s.check).toBe("function");
    }
  });

  it("the parallel-fanout regression runs offline (in CI, no stack)", () => {
    const fanout = scenarioById("parallel-fanout");
    expect(fanout.mode).toBe("both");
  });

  it("combineInvariants ANDs results and concatenates violations", () => {
    const merged = combineInvariants(
      assertSeqGapless([{ seq: 0 }, { seq: 1 }]),
      assertSeqGapless([{ seq: 0 }, { seq: 2 }]),
    );
    expect(merged.ok).toBe(false);
    expect(merged.violations).toHaveLength(1);
  });

  it("exports its package name", () => {
    expect(packageName).toBe("@teaspill/conformance");
  });
});

describe("liveTestTimeout (0002:T4.2 regression — vitest window must exceed the driver's)", () => {
  // The first live run killed ALL 5 scenarios at vitest's 5s default while the
  // driver's own observeUntil window was 30s. Every live it(...) passes
  // liveTestTimeout(...) so the vitest window STRICTLY exceeds the observe
  // window it wraps — guard that relationship here, offline.
  it("strictly exceeds the driver's observe window (default and explicit)", () => {
    const stack = readStackConfig({ TEASPILL_STACK_URL: "http://stack.example" });
    expect(stack).not.toBeNull();
    expect(liveTestTimeout(stack)).toBe(stack!.timeoutMs + LIVE_TEST_TIMEOUT_MARGIN_MS);
    expect(liveTestTimeout(stack)).toBeGreaterThan(stack!.timeoutMs);
    // Explicit observe ceiling (exec-durability's Math.max(timeoutMs, 60s) shape).
    expect(liveTestTimeout(stack, 60_000)).toBeGreaterThan(60_000);
  });

  it("honors TEASPILL_STACK_TIMEOUT_MS and survives a null config (skip path)", () => {
    const stack = readStackConfig({
      TEASPILL_STACK_URL: "http://stack.example",
      TEASPILL_STACK_TIMEOUT_MS: "90000",
    });
    expect(liveTestTimeout(stack)).toBe(90_000 + LIVE_TEST_TIMEOUT_MARGIN_MS);
    // Skipped suites still evaluate the timeout expression with stack === null.
    expect(liveTestTimeout(null)).toBeGreaterThan(30_000);
  });
});
