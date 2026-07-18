/**
 * FAULT 4 — Restate killed.
 *
 * INVARIANT (assert this, not "no crash"): killing Restate FULLY STOPS
 * coordination; on restart execution resumes CLEANLY with no state corruption —
 * the K/V seq counter and pending outbox survive, replay is an idempotent no-op
 * for already-confirmed work, and the projected timeline stays exactly-once and
 * seq-gapless (0001:A4 durable execution; the 0001:D2 single-writer K/V is the source of
 * truth, 0001:D1).
 *
 * OFFLINE (CI): the DURABLE-STATE half of 0001:A4 against the REAL projection outbox.
 * Restate's own full-stop/resume is a runtime guarantee (live-only), but the
 * property teaspill depends on is that COMMITTED K/V survives a restart and
 * replay is clean. We model a "Restate restart" as the in-flight invocation
 * vanishing while the entity K/V (seq counter, outbox, confirmed head) persists,
 * then a fresh invocation resuming:
 *   (a) after a fully-confirmed run → replay is a pure no-op (nothing duplicated);
 *   (b) after a staged-but-unflushed run → replay completes it exactly-once.
 * Both re-asserted with `assertExactlyOnceGapless` + the `crash-resume` `check`.
 *
 * LIVE (gated): `docker compose kill restate` (full stop) then `up -d`; re-drive
 * and re-assert the same invariant on the entity's real timeline.
 */

import { describe, expect, it } from "vitest";
import { DurableStreamsProjectionOutbox, timelineStreamPath } from "@teaspill/coordination";
import {
  MemoryWorld,
  FakeStreamsServer,
  assertExactlyOnceGapless,
  scenarioById,
  expectInvariant,
  createLiveDriver,
} from "@teaspill/conformance";
import { RESTATE_KILL } from "./faults.js";
import { readChaosConfig, CHAOS_SKIP_MESSAGE } from "./env.js";
import {
  assistantMessageInit,
  runFinishedInit,
  runStartedInit,
  spawnedInit,
  userMessageInit,
} from "./fixtures.js";

const CRASH_RESUME = scenarioById(RESTATE_KILL.scenarioId);

describe("FAULT 4 — Restate killed — offline (durable K/V survives; clean idempotent resume)", () => {
  it("(a) restart AFTER a fully-confirmed run replays as a pure no-op (no corruption, no dup)", async () => {
    const entity = "/t/default/a/conformance-echo/chaos-restate-a";
    const world = new MemoryWorld("chaos-restate-a");
    const server = new FakeStreamsServer();
    const outbox = new DurableStreamsProjectionOutbox({ transport: server });
    const path = timelineStreamPath(entity);

    // A run completes and is fully confirmed (seq 0..4).
    const w1 = world.ctx({ invocationId: "w1" });
    await outbox.stage(w1, entity, [
      spawnedInit,
      runStartedInit,
      userMessageInit("ping"),
      assistantMessageInit("pong"),
      runFinishedInit,
    ]);
    const confirmed = await outbox.flush(w1, entity);
    expect(confirmed).toStrictEqual({ appended: 5, headSeq: 4 });

    // RESTATE KILLED then restarted: the in-flight invocation is gone, but the
    // committed K/V (seq counter, confirmed head, empty outbox) survives — that
    // is exactly what MemoryWorld persists across a fresh ctx. A resuming
    // invocation flushes: pure no-op, nothing re-projected, no corruption.
    const resume = world.ctx({ invocationId: "w1-after-restart" });
    const resumed = await outbox.flush(resume, entity);
    expect(resumed).toStrictEqual({ appended: 0, headSeq: 4 });
    expect(world.kv<number>("seq")).toBe(5);

    const timeline = server.timeline(path);
    expect(timeline.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4]);
    expectInvariant(assertExactlyOnceGapless(timeline, { expectedFirstSeq: 0 }));
    expectInvariant(CRASH_RESUME.check(timeline, { expectedFirstSeq: 0 }));
  });

  it("(b) restart with a STAGED-but-unflushed outbox resumes exactly-once + gapless", async () => {
    const entity = "/t/default/a/conformance-echo/chaos-restate-b";
    const world = new MemoryWorld("chaos-restate-b");
    const server = new FakeStreamsServer();
    const outbox = new DurableStreamsProjectionOutbox({ transport: server });
    const path = timelineStreamPath(entity);

    // The handler staged events into the K/V outbox (seq allocated, committed
    // atomically under single-writer) but Restate was KILLED before the flush's
    // journaled append ran. The pending outbox survives in durable K/V.
    const staged = world.ctx({ invocationId: "w1" });
    await outbox.stage(staged, entity, [
      spawnedInit,
      runStartedInit,
      userMessageInit("ping"),
      assistantMessageInit("pong"),
      runFinishedInit,
    ]);
    expect(world.kv<unknown[]>("outbox")).toHaveLength(5);
    expect(server.rawRecords(path)).toHaveLength(0); // nothing appended yet

    // Restate restarts; a fresh invocation resumes the same key and flushes the
    // durable pending outbox — exactly-once, gapless, no double-projection.
    const resume = world.ctx({ invocationId: "w1-after-restart" });
    const resumed = await outbox.flush(resume, entity);
    expect(resumed).toStrictEqual({ appended: 5, headSeq: 4 });

    const timeline = server.timeline(path);
    expect(timeline.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4]);
    expectInvariant(assertExactlyOnceGapless(timeline, { expectedFirstSeq: 0 }));
    expectInvariant(CRASH_RESUME.check(timeline, { expectedFirstSeq: 0 }));
  });
});

// ---------------------------------------------------------------------------
// LIVE chaos (gated on TEASPILL_CHAOS + TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const chaos = readChaosConfig();

describe.skipIf(chaos === null)(
  `FAULT 4 — Restate killed — LIVE [${chaos?.stack.baseUrl ?? CHAOS_SKIP_MESSAGE}]`,
  () => {
    it("full-stop Restate then resume; the run completes exactly-once + gapless", async () => {
      const { stack, compose, services } = chaos!;
      const driver = createLiveDriver(stack);
      const spawned = await driver.actions.spawn({ type: stack.agentTypes.echo });
      await driver.actions.send(spawned.url, { text: "ping" });

      // Inject the fault: FULL STOP — kill Restate. Coordination halts entirely.
      compose.kill(services.restate);
      // Clean resume: bring Restate back; in-flight invocations replay from the
      // durable journal (0001:A4).
      compose.start(services.restate);
      await compose.waitHealthy(services.restate, 60_000);

      const events = await driver.observeUntil(
        spawned.streamUrl,
        (evs) => evs.some((e) => e.type === "run_finished"),
        { timeoutMs: Math.max(stack.timeoutMs, 120_000) },
      );
      expectInvariant(CRASH_RESUME.check(events, { expectedFirstSeq: 0 }));
    });
  },
);
