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

describe("conformance scenario registry", () => {
  it("exposes exactly the five 0001:T6.3 scenarios with unique ids", () => {
    expect(SCENARIOS.map((s) => s.id)).toStrictEqual([
      "spawn-respond",
      "parallel-fanout",
      "crash-resume",
      "projection-continuity",
      "workspace-exec-durability",
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
