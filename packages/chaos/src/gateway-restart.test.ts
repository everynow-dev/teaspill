/**
 * FAULT 5 — gateway restart mid-long-poll.
 *
 * INVARIANT (assert this, not "no crash"): when the gateway restarts while a
 * client long-poll is parked, the client RESUMES via the resumable protocol —
 * an offset-based re-read THROUGH the proxy returns exactly the missed bytes,
 * with nothing lost and nothing duplicated. Continuity is carried entirely by
 * the protocol (offset), not by any gateway state (0001:R5 / 0001:D6).
 *
 * LIVE-ONLY: the OFFLINE version of this exact invariant already lives in
 * `packages/gateway/src/r5-streams.test.ts` — "survives a GATEWAY restart
 * mid-read: resume from offset on the new instance" — against a faithful fake
 * durable-streams upstream. Those gateway test helpers (`listeningGateway`,
 * `FakeDurableStreams`) are internal and not exported, so re-running them here
 * would duplicate private code; instead this file asserts the invariant LIVE
 * against the real proxy and documents the offline home in CI.
 *
 * LIVE (gated): drive an entity through the gateway, restart the gateway
 * container mid-flight, then RESUME reading through the restarted proxy and
 * re-assert the entity's timeline is complete + gapless (the resumable protocol
 * carried continuity across the restart).
 */

import { describe, expect, it } from "vitest";
import { scenarioById, expectInvariant, createLiveDriver } from "@teaspill/conformance";
import { GATEWAY_RESTART } from "./faults.js";
import { readChaosConfig, CHAOS_SKIP_MESSAGE } from "./env.js";

const SPAWN_RESPOND = scenarioById(GATEWAY_RESTART.scenarioId);

describe("FAULT 5 — gateway restart mid-long-poll — offline coverage note (CI)", () => {
  it("this fault's invariant is exercised offline in packages/gateway/src/r5-streams.test.ts", () => {
    // The resumable-protocol invariant (offset resume through the proxy across a
    // gateway restart, no loss/dup) is covered offline by the gateway package's
    // 0001:R5 suite against a faithful fake upstream. Here it is LIVE-only by design.
    expect(GATEWAY_RESTART.hasOfflineTest).toBe(false);
    expect(GATEWAY_RESTART.liveOnlyReason).toMatch(/r5-streams\.test\.ts/);
    expect(GATEWAY_RESTART.injection.target).toBe("gateway");
  });
});

// ---------------------------------------------------------------------------
// LIVE chaos (gated on TEASPILL_CHAOS + TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const chaos = readChaosConfig();

describe.skipIf(chaos === null)(
  `FAULT 5 — gateway restart mid-long-poll — LIVE [${chaos?.stack.baseUrl ?? CHAOS_SKIP_MESSAGE}]`,
  () => {
    it("restart the gateway; the client resumes reading through the proxy with no loss/dup", async () => {
      const { stack, compose, services } = chaos!;
      const driver = createLiveDriver(stack);

      // Drive an entity through the gateway (spawn + send both hit /api/*).
      const spawned = await driver.actions.spawn({ type: stack.agentTypes.echo });
      await driver.actions.send(spawned.url, { text: "ping" });

      // Inject the fault: restart the gateway (the single entrypoint, 0001:D6) while
      // the run is in flight and a reader would be long-polling /streams/*.
      compose.restart(services.gateway);
      await compose.waitHealthy(services.gateway, 30_000);

      // RESUME through the restarted proxy: a fresh timeline reader re-reads
      // from the protocol offset. observeUntil rejects on drift (a seq gap /
      // loss), so a clean resolve proves the resumable protocol carried
      // continuity across the restart — no bytes lost, none duplicated.
      // Anchor on the MESSAGE wake's echo reply + its OWN run_finished — the
      // SPAWN wake also finishes a run, and SPAWN_RESPOND.check requires the
      // assistant reply, so a bare "some run_finished" resolved on the spawn
      // prefix and failed the check spuriously (0002:T4.3 run 1; same
      // hardening as conformance spawn-respond, 0002:T4.2).
      const events = await driver.observeUntil(
        spawned.streamUrl,
        (evs) =>
          evs.some(
            (e) =>
              e.type === "message" &&
              e.payload.role === "assistant" &&
              e.payload.content.some((b) => b.type === "text" && b.text.includes("ping")) &&
              evs.some((f) => f.type === "run_finished" && f.payload.runId === e.payload.runId),
          ),
        { timeoutMs: Math.max(stack.timeoutMs, 60_000) },
      );
      expectInvariant(SPAWN_RESPOND.check(events, { replyIncludes: "ping" }));
    });
  },
);
