/**
 * Scenario 2 — parallel fan-out (PERMANENT REGRESSION for the upstream
 * dropped-parent-wake bug). OFFLINE against the real coordination messaging
 * primitives (runs in CI), plus a live-gated end-to-end behind
 * `TEASPILL_STACK_URL`.
 */

import { describe, expect, it } from "vitest";
import { runParallelFanout } from "./parallel-fanout.js";
import { PARALLEL_FANOUT } from "./scenarios.js";
import { expectInvariant } from "./types.js";
import { countChildSpawned } from "./invariants.js";
import { createLiveDriver, readStackConfig, SKIP_MESSAGE } from "./live.js";

describe("parallel fan-out — offline (messaging primitives)", () => {
  it("a parent spawns N children in one wake; ALL N child_finished are delivered and gathered", async () => {
    const N = 4;
    const r = await runParallelFanout({ n: N });

    // N one-way spawn sends, each to its own child key.
    expect(r.spawnSendKeys).toEqual(["c-0", "c-1", "c-2", "c-3"]);
    // N child_spawned records on the parent timeline.
    expect(countChildSpawned(r.parentTimeline)).toBe(N);
    // Gather completes exactly at the LAST child — never before.
    expect(r.completedAtChild).toBe(N - 1);
    expect(r.gatherChildIds).toEqual([...r.childIds].sort());

    // The scenario's own invariant: all N child_finished present, gapless, structural.
    expectInvariant(PARALLEL_FANOUT.check(r.parentTimeline, { childIds: r.childIds }));
  });

  it("the check FAILS loudly if a child_finished is dropped (guards the regression itself)", async () => {
    const r = await runParallelFanout({ n: 3 });
    // Simulate the bug: drop one child's finish from the observed timeline.
    const dropped = r.parentTimeline.filter(
      (e) => !(e.type === "child_finished" && e.payload.childId === r.childIds[1]),
    );
    const result = PARALLEL_FANOUT.check(dropped, { childIds: r.childIds });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/missing child_finished/);
  });

  it("a redelivered child_finished never double-counts the gather (idempotent by childId)", async () => {
    const N = 3;
    const r = await runParallelFanout({ n: N, redeliverChild: 1 });
    // Redelivery did not pollute the timeline nor over-count the gather.
    expect(countChildSpawned(r.parentTimeline)).toBe(N);
    expect(r.gatherChildIds).toEqual([...r.childIds].sort());
    expect(r.gatherChildIds).toHaveLength(N);
    expectInvariant(PARALLEL_FANOUT.check(r.parentTimeline, { childIds: r.childIds }));
  });

  it("scales to a larger fan-out with zero seq collisions across the separate wakes", async () => {
    const N = 16;
    const r = await runParallelFanout({ n: N });
    expect(r.completedAtChild).toBe(N - 1);
    expectInvariant(PARALLEL_FANOUT.check(r.parentTimeline, { childIds: r.childIds }));
  });
});

// ---------------------------------------------------------------------------
// Live end-to-end (skip-guarded on TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const stack = readStackConfig();

describe.skipIf(stack === null)(`parallel fan-out — live e2e [${stack?.baseUrl ?? SKIP_MESSAGE}]`, () => {
  it("a live fan-out parent gathers all N child_finished", async () => {
    const driver = createLiveDriver(stack!);
    const N = 4;
    const spawned = await driver.actions.spawn({
      type: stack!.agentTypes.fanoutParent,
      args: { n: N, childType: stack!.agentTypes.fanoutChild },
    });
    const events = await driver.observeUntil(
      spawned.streamUrl,
      (evs) => evs.filter((e) => e.type === "child_finished").length >= N,
    );
    const childIds = events
      .filter((e) => e.type === "child_spawned")
      .map((e) => (e as Extract<typeof e, { type: "child_spawned" }>).payload.childId);
    expect(childIds).toHaveLength(N);
    expectInvariant(PARALLEL_FANOUT.check(events, { childIds }));
  });
});
