/**
 * Scenario 3 — crash-mid-run resume. OFFLINE against the REAL projection outbox
 * (`DurableStreamsProjectionOutbox`) over a faithful fake streams server: a run
 * that crashes between append and trim (the 0001:D3 confirm-then-trim window)
 * resumes with NO duplicate events — the projected timeline stays exactly-once
 * and seq-gapless (0001:A1). Plus a live-gated end-to-end.
 */

import { describe, expect, it } from "vitest";
import { DurableStreamsProjectionOutbox, timelineStreamPath } from "@teaspill/coordination";
import { CRASH_RESUME } from "./scenarios.js";
import { expectInvariant } from "./types.js";
import { MemoryWorld } from "./support/memory-ctx.js";
import { FakeStreamsServer } from "./support/fake-streams.js";
import {
  assistantMessageInit,
  runFinishedInit,
  runStartedInit,
  spawnedInit,
  userMessageInit,
} from "./support/run-fixtures.js";
import { createLiveDriver, readStackConfig, SKIP_MESSAGE } from "./live.js";

const ENTITY = "/t/default/a/conformance-echo/e-1";

/** Drive the offline crash-replay and return the resulting stream timeline. */
async function runCrashReplay() {
  const world = new MemoryWorld("e-1");
  const server = new FakeStreamsServer();
  const outbox = new DurableStreamsProjectionOutbox({ transport: server });
  const path = timelineStreamPath(ENTITY);

  // Wake 1: spawn + run_started + the user's message — cleanly confirmed (seq 0..2).
  const w1 = world.ctx({ invocationId: "w1" });
  await outbox.stage(w1, ENTITY, [spawnedInit, runStartedInit, userMessageInit("ping")]);
  const first = await outbox.flush(w1, ENTITY);

  // Wake 2: the assistant reply + run_finished are staged, then the flush
  // CRASHES after the append lands on the stream but before the trim — the
  // exact 0001:D3 confirm-then-trim window.
  const crashing = world.ctx({ invocationId: "w2", crashAfterRun: true });
  await outbox.stage(crashing, ENTITY, [assistantMessageInit("pong"), runFinishedInit]);
  const crashErr = await outbox.flush(crashing, ENTITY).then(
    () => null,
    (e: unknown) => e,
  );

  // The retried wake replays from the first unconfirmed; the already-appended
  // seq 3,4 come back as duplicates (204 no-op) — nothing is re-projected.
  const retry = world.ctx({ invocationId: "w2-retry" });
  const resumed = await outbox.flush(retry, ENTITY);

  return { timeline: server.timeline(path), server, first, crashErr, resumed };
}

describe("crash-mid-run resume — offline (outbox crash-replay)", () => {
  it("a crash between append and trim resumes exactly-once and gapless", async () => {
    const { timeline, server, first, crashErr, resumed } = await runCrashReplay();

    expect(first).toStrictEqual({ appended: 3, headSeq: 2 });
    expect(crashErr).toBeInstanceOf(Error);
    expect((crashErr as Error).message).toMatch(/simulated crash/);
    // Replay confirmed everything with zero NEW appends (all duplicates).
    expect(resumed).toStrictEqual({ appended: 0, headSeq: 4 });

    // Exactly-once + gapless on the stream (seq 0..4, each once).
    expect(timeline.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4]);
    expectInvariant(CRASH_RESUME.check(timeline));
    // The crashed attempt DID land its appends (proving the crash was mid-flush,
    // not before it) — otherwise this would be a trivial pass.
    expect(server.appendRequests).toBeGreaterThan(5);
  });

  it("the check catches a duplicate event that survived to the reader", async () => {
    const { timeline } = await runCrashReplay();
    // Inject the failure exactly-once prevents: a second copy of seq 1.
    const withDuplicate = [...timeline, timeline[1]!];
    const result = CRASH_RESUME.check(withDuplicate);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/duplicate seq/);
  });
});

// ---------------------------------------------------------------------------
// Live end-to-end (skip-guarded on TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const stack = readStackConfig();

describe.skipIf(stack === null)(
  `crash-mid-run resume — live e2e [${stack?.baseUrl ?? SKIP_MESSAGE}]`,
  () => {
    it("a live run's timeline is exactly-once and gapless (no duplicate events under retry)", async () => {
      const driver = createLiveDriver(stack!);
      const spawned = await driver.actions.spawn({ type: stack!.agentTypes.echo });
      await driver.actions.send(spawned.url, { text: "ping" });
      const events = await driver.observeUntil(spawned.streamUrl, (evs) =>
        evs.some((e) => e.type === "run_finished"),
      );
      // observeUntil already rejects on any drift (seq gap); assert exactly-once too.
      expectInvariant(CRASH_RESUME.check(events, { expectedFirstSeq: 0 }));
    });
  },
);
