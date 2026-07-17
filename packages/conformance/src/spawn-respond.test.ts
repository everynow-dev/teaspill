/**
 * Scenario 1 — spawn → respond. The genuine end-to-end (spawn an agent, send a
 * message, observe the reply + run_finished) needs a live stack, so it is
 * gated on `TEASPILL_STACK_URL`. Offline, CI exercises the OBSERVATION/checker
 * logic the live test relies on, over a real outbox-projected timeline — so a
 * broken invariant checker fails in CI, not only against a stack.
 */

import { describe, expect, it } from "vitest";
import { DurableStreamsProjectionOutbox, timelineStreamPath } from "@teaspill/coordination";
import { SPAWN_RESPOND } from "./scenarios.js";
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

const ENTITY = "/t/default/a/conformance-echo/e-3";

async function respondedTimeline() {
  const world = new MemoryWorld("e-3");
  const server = new FakeStreamsServer();
  const outbox = new DurableStreamsProjectionOutbox({ transport: server });
  const ctx = world.ctx({ invocationId: "w1" });
  await outbox.stage(ctx, ENTITY, [
    spawnedInit,
    runStartedInit,
    userMessageInit("ping"),
    assistantMessageInit("pong"),
    runFinishedInit,
  ]);
  await outbox.flush(ctx, ENTITY);
  return server.timeline(timelineStreamPath(ENTITY));
}

describe("spawn → respond — offline (checker over a projected timeline)", () => {
  it("recognizes a well-formed spawn→respond timeline", async () => {
    const timeline = await respondedTimeline();
    expectInvariant(SPAWN_RESPOND.check(timeline, { replyIncludes: "pong" }));
  });

  it("fails when there is no successful run_finished", async () => {
    const timeline = (await respondedTimeline()).filter((e) => e.type !== "run_finished");
    const result = SPAWN_RESPOND.check(timeline, { replyIncludes: "pong" });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/run_finished/);
  });

  it("fails when the reply text does not match the expectation", async () => {
    const timeline = await respondedTimeline();
    const result = SPAWN_RESPOND.check(timeline, { replyIncludes: "not-in-reply" });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/does not include/);
  });
});

// ---------------------------------------------------------------------------
// Live end-to-end (skip-guarded on TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const stack = readStackConfig();

describe.skipIf(stack === null)(`spawn → respond — live e2e [${stack?.baseUrl ?? SKIP_MESSAGE}]`, () => {
  it("spawn an echo agent, send a message, observe the reply and run_finished", async () => {
    const driver = createLiveDriver(stack!);
    const spawned = await driver.actions.spawn({ type: stack!.agentTypes.echo });
    await driver.actions.send(spawned.url, { text: "hello teaspill" });
    const events = await driver.observeUntil(spawned.streamUrl, (evs) =>
      evs.some((e) => e.type === "run_finished"),
    );
    expectInvariant(SPAWN_RESPOND.check(events, { replyIncludes: "hello teaspill" }));
  });
});
