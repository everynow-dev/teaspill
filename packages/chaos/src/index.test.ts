/**
 * Wiring self-test (CI): the fault registry is well-formed, every fault maps to
 * a REAL conformance scenario, and the env-gate skips cleanly with no stack.
 * This runs offline in CI — it never touches docker or a stack.
 */

import { describe, expect, it } from "vitest";
import { scenarioById } from "@teaspill/conformance";
import { FAULTS, faultById } from "./faults.js";
import { readChaosConfig, isFlagEnabled, DEFAULT_SERVICE_NAMES } from "./env.js";

describe("chaos fault registry", () => {
  it("registers exactly the 5 PLAN 0001:T9.1 faults, each with an invariant statement", () => {
    expect(FAULTS.map((f) => f.id)).toStrictEqual([
      "agent-loop-kill-mid-llm",
      "executor-kill-mid-exec",
      "streams-server-kill",
      "restate-kill",
      "gateway-restart-mid-long-poll",
    ]);
    for (const f of FAULTS) {
      // The invariant is the point — it must NOT be a bare "no crash".
      expect(f.invariant.length).toBeGreaterThan(20);
      expect(f.invariant.toLowerCase()).not.toBe("no crash");
      expect(f.asserts.length).toBeGreaterThan(0);
    }
  });

  it("maps every fault to a real conformance scenario it re-asserts", () => {
    for (const f of FAULTS) {
      const scenario = scenarioById(f.scenarioId); // throws on unknown id
      expect(typeof scenario.check).toBe("function");
    }
  });

  it("faultById throws on an unknown id", () => {
    expect(() => faultById("nope")).toThrow(/unknown chaos fault/);
  });

  it("exactly faults 1-4 have an offline invariant test; fault 5 is live-only", () => {
    const offline = FAULTS.filter((f) => f.hasOfflineTest).map((f) => f.id);
    expect(offline).toStrictEqual([
      "agent-loop-kill-mid-llm",
      "executor-kill-mid-exec",
      "streams-server-kill",
      "restate-kill",
    ]);
    const liveOnly = FAULTS.filter((f) => !f.hasOfflineTest);
    expect(liveOnly.map((f) => f.id)).toStrictEqual(["gateway-restart-mid-long-poll"]);
    expect(liveOnly[0]!.liveOnlyReason).toBeTruthy();
  });
});

describe("chaos env-gate", () => {
  it("skips cleanly (readChaosConfig === null) unless BOTH flags are set", () => {
    expect(readChaosConfig({})).toBeNull();
    expect(readChaosConfig({ TEASPILL_CHAOS: "1" })).toBeNull(); // no stack url
    expect(readChaosConfig({ TEASPILL_STACK_URL: "http://x" })).toBeNull(); // not opted in
  });

  it("resolves a config when both TEASPILL_CHAOS and TEASPILL_STACK_URL are set", () => {
    const cfg = readChaosConfig({ TEASPILL_CHAOS: "1", TEASPILL_STACK_URL: "http://localhost:8080" });
    expect(cfg).not.toBeNull();
    expect(cfg!.stack.baseUrl).toBe("http://localhost:8080");
    expect(cfg!.services).toStrictEqual(DEFAULT_SERVICE_NAMES);
    expect(cfg!.compose).toBeDefined(); // lazy — constructed, but no docker touched
  });

  it("isFlagEnabled accepts the usual truthy spellings only", () => {
    for (const yes of ["1", "true", "TRUE", "yes", "on"]) expect(isFlagEnabled(yes)).toBe(true);
    for (const no of [undefined, "", "0", "false", "off", "no"]) expect(isFlagEnabled(no)).toBe(false);
  });
});
