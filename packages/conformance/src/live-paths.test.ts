/**
 * Never-live paths turned on and confirmed against a REAL stack (0002:T4.2):
 *
 *   1. Real interrupt via `ctx.cancel` (@experimental, 0001:A4 — "conformance-
 *      test this seam"): a live `interrupt` verb through the gateway reaches a
 *      BUSY onWake-only wake (the long-exec conformance agent mid-exec), the
 *      exec is killed via 0002:T3.1's abort→kill, and the timeline records
 *      `control(interrupt)` + `run_finished(interrupted)` — gapless.
 *   2. Idle auto-archive → resurrection round-trip (0001:A10/0001:D7): an idle
 *      entity self-archives (`state_snapshot(pre_archive)` + terminal
 *      `archived`), and the NEXT send resurrects it from the catalog snapshot
 *      with the canonical seq continuing gapless across the boundary.
 *      Requires the agent-loop deployed with a SHORT idle window
 *      (`TEASPILL_IDLE_ARCHIVE_MS`, additive 0002:T4.2 env) — gated on
 *      `TEASPILL_LIVE_IDLE_ARCHIVE_MS` naming that window.
 *   3. Steer push → wake-start drain (0001:D2/0001:T2.6, via the additive
 *      per-entity `steerSourceFactory` seam closing 0002:T4.1's flag): a
 *      message pushed to an idle entity's steerbox becomes the FIRST input of
 *      its next wake. (Mid-run boundary drains need a live LLM harness run —
 *      0002:T4.4's soak; the push/drain transport and the no-loss wake-start
 *      contract are what this confirms live.)
 *
 * All suites skip without `TEASPILL_STACK_URL`. The steer push uses Restate
 * ingress directly (`TEASPILL_STACK_INGRESS_URL`, default the compose-mapped
 * `http://localhost:8080`) — steering is an agent-to-agent surface; the
 * gateway deliberately does not expose the steerbox (0001:D6).
 */

import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@teaspill/schema";
import { createLiveDriver, liveTestTimeout, readStackConfig, SKIP_MESSAGE } from "./live.js";

const stack = readStackConfig();

const INGRESS_URL = (process.env["TEASPILL_STACK_INGRESS_URL"] ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);

const messageWakeReply = (evs: readonly TimelineEvent[], includes: string) =>
  evs.find(
    (e) =>
      e.type === "message" &&
      e.payload.role === "assistant" &&
      e.payload.content.some((b) => b.type === "text" && b.text.includes(includes)),
  );

// ---------------------------------------------------------------------------
// 1. Real interrupt via ctx.cancel (A4 @experimental seam)
// ---------------------------------------------------------------------------

describe.skipIf(stack === null)(
  `real interrupt (ctx.cancel) — live [${stack?.baseUrl ?? SKIP_MESSAGE}]`,
  () => {
    it("interrupts a busy long-exec wake: exec killed, control(interrupt) + run_finished(interrupted), gapless", async () => {
      const driver = createLiveDriver(stack!);
      const spawned = await driver.actions.spawn({ type: stack!.agentTypes.longExec });
      await driver.actions.send(spawned.url, { command: "sleep 300 && echo never" });

      // Wait until the MESSAGE wake is in flight (its run_started is on the
      // timeline) so the interrupt has a busy invocation to cancel.
      await driver.observeUntil(spawned.streamUrl, (evs) =>
        evs.some(
          (e) => e.type === "run_started" && e.payload.wake.source === "message",
        ),
      );
      await driver.actions.interrupt(spawned.url, "conformance live interrupt");

      const events = await driver.observeUntil(spawned.streamUrl, (evs) =>
        evs.some((e) => e.type === "run_finished" && e.payload.outcome === "interrupted"),
      );

      // control(interrupt) recorded by the wound-down wake (0001:A8: verb only).
      const control = events.find((e) => e.type === "control");
      expect(control, "control(interrupt) event").toBeDefined();
      expect(control!.type === "control" && control!.payload.verb).toBe("interrupt");

      // The interrupted run is the message wake's run, and the exec did NOT
      // run to completion (a 300s sleep finishing in <30s is impossible).
      const finished = events.find(
        (e) => e.type === "run_finished" && e.payload.outcome === "interrupted",
      );
      expect(finished).toBeDefined();
      // Timeline stayed gapless (observeUntil rejects on drift) and the wake
      // wound down rather than wedging — 0001:A4's explicitCancellation
      // contract, live.
    }, liveTestTimeout(stack));
  },
);

// ---------------------------------------------------------------------------
// 2. Idle auto-archive → resurrection (A10/D7)
// ---------------------------------------------------------------------------

const idleMsRaw = process.env["TEASPILL_LIVE_IDLE_ARCHIVE_MS"];
const idleMs = idleMsRaw !== undefined && idleMsRaw !== "" ? Number(idleMsRaw) : null;

describe.skipIf(stack === null || idleMs === null)(
  `idle auto-archive → resurrection — live [${stack?.baseUrl ?? SKIP_MESSAGE}; set TEASPILL_LIVE_IDLE_ARCHIVE_MS to the stack's TEASPILL_IDLE_ARCHIVE_MS to enable]`,
  () => {
    it("an idle entity self-archives (snapshot + terminal event) and the next send resurrects it, seq gapless across the boundary", async () => {
      const driver = createLiveDriver(stack!);
      const spawned = await driver.actions.spawn({ type: stack!.agentTypes.echo });
      await driver.actions.send(spawned.url, { text: "before-archive" });
      await driver.observeUntil(spawned.streamUrl, (evs) =>
        messageWakeReply(evs, "before-archive") !== undefined,
      );

      // Idle tick fires after the stack's short idle window ⇒ pre_archive
      // snapshot + terminal `archived` land on the stream (0001:A10).
      const archivedEvents = await driver.observeUntil(
        spawned.streamUrl,
        (evs) => evs.some((e) => e.type === "archived"),
        { timeoutMs: idleMs! * 4 + 30_000 },
      );
      const snapshot = archivedEvents.find(
        (e) => e.type === "state_snapshot" && e.payload.reason === "pre_archive",
      );
      expect(snapshot, "state_snapshot(pre_archive)").toBeDefined();
      const archived = archivedEvents.find((e) => e.type === "archived");
      expect(archived!.type === "archived" && archived!.payload.snapshotSeq).toBe(snapshot!.seq);

      // Resurrection: the next send rehydrates from the catalog snapshot
      // (0001:D7 — never the stream) and the echo replies; canonical seq
      // CONTINUES (gapless across the archive boundary; observeUntil drift-
      // rejects, and the reply must land at a seq above the terminal event).
      await driver.actions.send(spawned.url, { text: "after-archive" });
      const resurrected = await driver.observeUntil(spawned.streamUrl, (evs) => {
        const reply = messageWakeReply(evs, "after-archive");
        return (
          reply !== undefined &&
          evs.some((e) => e.type === "run_finished" && e.payload.runId === (reply as Extract<TimelineEvent, { type: "message" }>).payload.runId)
        );
      });
      const reply = messageWakeReply(resurrected, "after-archive")!;
      expect(reply.seq).toBeGreaterThan(archived!.seq);
      // Full-replay contiguity 0..head across the archive boundary.
      const seqs = resurrected.map((e) => e.seq);
      expect(seqs[0]).toBe(0);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    }, liveTestTimeout(stack, (idleMs ?? 0) * 4 + 60_000));
  },
);

// ---------------------------------------------------------------------------
// 3. Steer push → wake-start drain (D2/T2.6 no-loss contract)
// ---------------------------------------------------------------------------

describe.skipIf(stack === null)(
  `steer push → wake-start drain — live [${stack?.baseUrl ?? SKIP_MESSAGE}]`,
  () => {
    it("a steer pushed to an idle entity becomes the FIRST input of its next wake", async () => {
      const driver = createLiveDriver(stack!);
      const spawned = await driver.actions.spawn({ type: stack!.agentTypes.echo });
      await driver.actions.send(spawned.url, { text: "warm-up" });
      await driver.observeUntil(spawned.streamUrl, (evs) =>
        messageWakeReply(evs, "warm-up") !== undefined,
      );

      // Push into the idle entity's steerbox via Restate ingress (the
      // steerbox key is the FULL entity url — https://teaspill.everynow.dev/reference/addressing).
      const res = await fetch(
        `${INGRESS_URL}/steer/${encodeURIComponent(spawned.url)}/push`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "steer-live-1",
            content: [{ type: "text", text: "steered-input" }],
          }),
        },
      );
      expect(res.ok, `steer push HTTP ${res.status}`).toBe(true);
      const pushed = (await res.json()) as { queued: number };
      expect(pushed.queued).toBeGreaterThanOrEqual(1);

      // Next wake: the wake-start drain (0001:T2.6 no-loss) must fold the
      // steered message in AHEAD of the wake's own input.
      await driver.actions.send(spawned.url, { text: "next-wake" });
      const events = await driver.observeUntil(spawned.streamUrl, (evs) =>
        messageWakeReply(evs, "next-wake") !== undefined,
      );

      const steered = events.find(
        (e) => e.type === "message" && e.payload.id === "steer-live-1",
      );
      expect(steered, "drained steer message on the timeline").toBeDefined();
      const wakeInput = events.find(
        (e) =>
          e.type === "message" &&
          e.payload.role === "user" &&
          e.payload.content.some((b) => b.type === "text" && b.text.includes("next-wake")),
      );
      expect(wakeInput).toBeDefined();
      // Drained BEFORE the wake's own input (the no-loss ordering contract).
      expect(steered!.seq).toBeLessThan(wakeInput!.seq);
    }, liveTestTimeout(stack));
  },
);
