/**
 * FAULT 1 — agent-loop killed mid-LLM-call.
 *
 * INVARIANT (assert this, not "no crash"): after the agent-loop dies mid-run and
 * Restate re-dispatches the wake, the run RESUMES and the projected timeline has
 * NO duplicate events — it stays exactly-once and seq-gapless (0001:A1/0001:A4 replay; a
 * completed `ctx.run` is not re-run, and its already-landed append dedups on
 * replay). This is the `crash-resume` conformance scenario with the crash placed
 * exactly at the agent-loop-mid-LLM-call boundary.
 *
 * OFFLINE (CI): the REAL projection outbox (`DurableStreamsProjectionOutbox`)
 * over conformance's faithful fake streams server + memory world. Wake 2 (the
 * LLM-call wake) crashes AFTER its append lands but BEFORE the trim — the 0001:D3
 * confirm-then-trim window a mid-LLM-call kill lands in. The retried wake
 * replays from the first unconfirmed; the already-appended seqs come back as
 * 204 no-ops (nothing re-projected). Re-asserted with `assertExactlyOnceGapless`
 * and the `crash-resume` scenario `check`.
 *
 * LIVE (gated): kill the agent-loop container mid-run, let Restate re-dispatch,
 * then re-assert the same invariant on the entity's real timeline.
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
import { AGENT_LOOP_KILL } from "./faults.js";
import { readChaosConfig, CHAOS_SKIP_MESSAGE } from "./env.js";
import {
  assistantMessageInit,
  runFinishedInit,
  runStartedInit,
  spawnedInit,
  userMessageInit,
} from "./fixtures.js";

const ENTITY = "/t/default/a/conformance-echo/chaos-agent-loop";
const CRASH_RESUME = scenarioById(AGENT_LOOP_KILL.scenarioId);

/**
 * Drive the offline crash-replay modelling an agent-loop killed mid-LLM-call and
 * return the resulting stream timeline. Wake 2 crashes mid-flush (after append,
 * before trim); the retried wake replays exactly-once.
 */
async function runAgentLoopKillReplay() {
  const world = new MemoryWorld("chaos-agent-loop");
  const server = new FakeStreamsServer();
  const outbox = new DurableStreamsProjectionOutbox({ transport: server });
  const path = timelineStreamPath(ENTITY);

  // Wake 1: spawn + run_started + the user message — cleanly confirmed (seq 0..2).
  const w1 = world.ctx({ invocationId: "w1" });
  await outbox.stage(w1, ENTITY, [spawnedInit, runStartedInit, userMessageInit("ping")]);
  const first = await outbox.flush(w1, ENTITY);

  // Wake 2: the LLM call produced the assistant reply + run_finished; the
  // agent-loop is KILLED mid-flush — the append lands on the stream but the
  // trim never runs (the 0001:D3 confirm-then-trim window).
  const crashing = world.ctx({ invocationId: "w2", crashAfterRun: true });
  await outbox.stage(crashing, ENTITY, [assistantMessageInit("pong"), runFinishedInit]);
  const crashErr = await outbox.flush(crashing, ENTITY).then(
    () => null,
    (e: unknown) => e,
  );

  // Restate re-dispatches the wake on a fresh replica: replay from the first
  // unconfirmed. seq 3,4 already landed → 204 no-ops → nothing re-projected.
  const retry = world.ctx({ invocationId: "w2-retry" });
  const resumed = await outbox.flush(retry, ENTITY);

  return { timeline: server.timeline(path), server, first, crashErr, resumed };
}

describe("FAULT 1 — agent-loop killed mid-LLM-call — offline (outbox exactly-once replay)", () => {
  it("the run resumes with NO duplicate events (exactly-once + gapless)", async () => {
    const { timeline, server, first, crashErr, resumed } = await runAgentLoopKillReplay();

    expect(first).toStrictEqual({ appended: 3, headSeq: 2 });
    expect(crashErr).toBeInstanceOf(Error);
    // Replay confirmed everything with ZERO new appends — the completed
    // ctx.run's append was NOT re-projected (0001:A4 / 0001:A6 dedup).
    expect(resumed).toStrictEqual({ appended: 0, headSeq: 4 });

    // Exactly-once + gapless on the stream (seq 0..4, each once).
    expect(timeline.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4]);
    expectInvariant(assertExactlyOnceGapless(timeline, { expectedFirstSeq: 0 }));
    expectInvariant(CRASH_RESUME.check(timeline, { expectedFirstSeq: 0 }));

    // The crashed attempt DID land its appends (proving the kill was mid-flush,
    // not before it) — otherwise this would be a trivial pass.
    expect(server.appendRequests).toBeGreaterThan(5);
  });

  it("the invariant CATCHES a duplicate event that survived the kill", async () => {
    const { timeline } = await runAgentLoopKillReplay();
    // The failure a mid-LLM-call kill must NOT produce: a re-projected assistant
    // message (seq 3 twice).
    const withDuplicate = [...timeline, timeline[3]!];
    const result = assertExactlyOnceGapless(withDuplicate);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/duplicate seq/);
  });
});

// ---------------------------------------------------------------------------
// LIVE chaos (gated on TEASPILL_CHAOS + TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const chaos = readChaosConfig();

describe.skipIf(chaos === null)(
  `FAULT 1 — agent-loop killed mid-LLM-call — LIVE [${chaos?.stack.baseUrl ?? CHAOS_SKIP_MESSAGE}]`,
  () => {
    it("kill the agent-loop mid-run; the retried run's timeline is exactly-once + gapless", async () => {
      const { stack, compose, services } = chaos!;
      const driver = createLiveDriver(stack);
      const spawned = await driver.actions.spawn({ type: stack.agentTypes.echo });
      await driver.actions.send(spawned.url, { text: "ping" });

      // Inject the fault mid-run: kill the agent-loop replica. Restate
      // re-dispatches the wake to a surviving/restarted replica.
      compose.kill(services.agentLoop);
      compose.start(services.agentLoop);
      await compose.waitHealthy(services.agentLoop, 30_000);

      // The run must still finish, and its timeline must be exactly-once +
      // gapless (observeUntil rejects on any drift/seq gap).
      const events = await driver.observeUntil(
        spawned.streamUrl,
        (evs) => evs.some((e) => e.type === "run_finished"),
        { timeoutMs: Math.max(stack.timeoutMs, 60_000) },
      );
      expectInvariant(CRASH_RESUME.check(events, { expectedFirstSeq: 0 }));
    });
  },
);
