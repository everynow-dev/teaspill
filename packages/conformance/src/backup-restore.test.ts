/**
 * Scenario 6 — backup lossy-combo restore (0002:T5.3). The automated regression
 * 0001:T8.3 flagged as an open question: assert https://teaspill.everynow.dev/guides/operations/backup-restore —
 * restore catalog+streams WITHOUT Restate ⇒ a never-archived ACTIVE entity is
 * LOST (its next wake throws the loud `restate.TerminalError` "has no live
 * state") while a previously-ARCHIVED entity resurrects fine from its catalog
 * snapshot (0001:D7 / 0001:A10).
 *
 * OFFLINE (CI, always runs): the scenario's pure `check` (archived resurrection
 * is a real spawn→respond timeline) and the exact terminal-error string the
 * negative half pins, plus the chaos-tier skip-guard's own logic.
 *
 * LIVE (gated on TEASPILL_CHAOS=1 + TEASPILL_STACK_URL — chaos-tier, because it
 * SCRIPT-DRIVES the destructive scripts/backup.sh + scripts/restore.sh against a
 * real docker stack): reproduce §4.2 end-to-end using ONLY the two scripts.
 */

import { describe, expect, it } from "vitest";
import { DurableStreamsProjectionOutbox, timelineStreamPath } from "@teaspill/coordination";
import type { AgentTimelineState } from "@teaspill/frontend-sdk";
import type { TimelineEvent } from "@teaspill/schema";
import { BACKUP_LOSSY_RESTORE } from "./scenarios.js";
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
import { createLiveDriver } from "./live.js";
import {
  BackupRestoreCli,
  BACKUP_SKIP_MESSAGE,
  isChaosFlagEnabled,
  noLiveStateTerminalError,
  readBackupRegressionConfig,
} from "./backup-restore.js";

// ---------------------------------------------------------------------------
// Offline (always runs in CI — no stack, no TEASPILL_CHAOS)
// ---------------------------------------------------------------------------

const ARCHIVED_ENTITY = "/t/default/a/conformance-echo/e-archived";

/** Build a real resurrected-style timeline (spawn→respond) via the outbox. */
async function resurrectedTimeline(reply: string): Promise<TimelineEvent[]> {
  const world = new MemoryWorld("e-archived");
  const server = new FakeStreamsServer();
  const outbox = new DurableStreamsProjectionOutbox({ transport: server });
  const path = timelineStreamPath(ARCHIVED_ENTITY);
  const w = world.ctx({ invocationId: "resurrect" });
  await outbox.stage(w, ARCHIVED_ENTITY, [
    spawnedInit,
    runStartedInit,
    userMessageInit("wake-again"),
    assistantMessageInit(reply),
    runFinishedInit,
  ]);
  await outbox.flush(w, ARCHIVED_ENTITY);
  return server.timeline(path);
}

describe("backup lossy-combo restore — offline (scenario check + pinned error string)", () => {
  it("the archived-resurrection half PASSES on a real spawn→respond timeline", async () => {
    const timeline = await resurrectedTimeline("echo: wake-again");
    // Positive half: resurrection is transparent — a normal responded timeline.
    expectInvariant(BACKUP_LOSSY_RESTORE.check(timeline, { replyIncludes: "wake-again" }));
  });

  it("the check FAILS if the resurrected entity produced no assistant response", async () => {
    const timeline = await resurrectedTimeline("echo: wake-again");
    // Drop the assistant message — models an entity that did NOT actually
    // resurrect/respond (what the active-entity loss would look like as a timeline).
    const noReply = timeline.filter(
      (e) => !(e.type === "message" && e.payload.role === "assistant"),
    );
    const result = BACKUP_LOSSY_RESTORE.check(noReply, { replyIncludes: "wake-again" });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/assistant `message`|does not include/);
  });

  it("pins the EXACT loud TerminalError the active-entity-lost half asserts", () => {
    // This constant is the regression: it must byte-match what
    // packages/coordination/src/agent.ts `handleMessage` throws.
    expect(noLiveStateTerminalError("/t/default/a/conformance-echo/e-active")).toBe(
      "agent /t/default/a/conformance-echo/e-active has no live state " +
        "(not spawned, or archived with no resurrectable snapshot)",
    );
  });

  it("the chaos-tier flag helper matches chaos's isFlagEnabled semantics", () => {
    for (const yes of ["1", "true", "YES", " on "]) expect(isChaosFlagEnabled(yes)).toBe(true);
    for (const no of [undefined, "", "0", "false", "no"]) expect(isChaosFlagEnabled(no)).toBe(false);
  });

  it("skip-guard returns null unless BOTH TEASPILL_CHAOS and TEASPILL_STACK_URL are set", () => {
    expect(readBackupRegressionConfig({})).toBeNull();
    expect(readBackupRegressionConfig({ TEASPILL_CHAOS: "1" })).toBeNull();
    expect(
      readBackupRegressionConfig({ TEASPILL_STACK_URL: "http://localhost:8080" }),
    ).toBeNull();
    const cfg = readBackupRegressionConfig({
      TEASPILL_CHAOS: "1",
      TEASPILL_STACK_URL: "http://localhost:8080",
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.stack.baseUrl).toBe("http://localhost:8080");
    // Default scripts dir resolves to the repo-root scripts/ (where the two live).
    expect(cfg!.scriptsDir).toMatch(/scripts$/);
  });
});

// ---------------------------------------------------------------------------
// Live + chaos (gated on TEASPILL_CHAOS=1 AND TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const config = readBackupRegressionConfig();

/** Observe a raw timeline until `predicate(state)` holds, or reject on timeout. */
function observeStateUntil(
  driver: ReturnType<typeof createLiveDriver>,
  streamUrl: string,
  predicate: (s: AgentTimelineState) => boolean,
  timeoutMs: number,
): Promise<void> {
  const timeline = driver.openTimeline(streamUrl, { live: true });
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      timeline.close();
      if (err !== undefined) reject(err);
      else resolve();
    };
    const unsubscribe = timeline.subscribe((s) => {
      if (predicate(s)) finish();
    });
    const timer = setTimeout(
      () => finish(new Error(`timed out after ${timeoutMs}ms observing ${streamUrl}`)),
      timeoutMs,
    );
  });
}

describe.skipIf(config === null)(
  `backup lossy-combo restore — live+chaos [${config?.stack.baseUrl ?? BACKUP_SKIP_MESSAGE}]`,
  () => {
    it(
      "catalog+streams WITHOUT Restate: archived resurrects, active is lost (loud TerminalError)",
      async () => {
        const { stack } = config!;
        const driver = createLiveDriver(stack);
        const cli = new BackupRestoreCli(config!);
        // Two temp backup dirs under the OS tmp root (never inside the repo).
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const root = mkdtempSync(join(tmpdir(), "teaspill-t53-"));
        const emptyBackup = join(root, "empty");
        const fullBackup = join(root, "full");

        // 1. Baseline backup of the stack with an EMPTY Restate working set. This
        //    is the ONLY script-based way to later CLEAR Restate: restore.sh
        //    --restate from this empty snapshot wipes Restate's volume ⇒ no live
        //    K/V (and, being a real disk loss, no service registration either —
        //    see the re-register NOTE below).
        cli.backup(emptyBackup);

        // 2. An ACTIVE entity (live only in Restate K/V) and an entity we ARCHIVE
        //    (its snapshot is persisted to the catalog, 0001:D7/0001:A10).
        const active = await driver.actions.spawn({ type: stack.agentTypes.echo });
        await driver.actions.send(active.url, { text: "active-hello" });
        await driver.observeUntil(active.streamUrl, (evs) =>
          evs.some((e) => e.type === "run_finished"),
        );

        const archived = await driver.actions.spawn({ type: stack.agentTypes.echo });
        await driver.actions.send(archived.url, { text: "archived-hello" });
        await driver.observeUntil(archived.streamUrl, (evs) =>
          evs.some((e) => e.type === "run_finished"),
        );
        await driver.actions.archive(archived.url);
        // Wait until archival is projected (the reducer's `archived` view) — this
        // guarantees the catalog snapshot is written before the full backup.
        await observeStateUntil(
          driver,
          archived.streamUrl,
          (s) => s.timeline.archived !== null,
          Math.max(stack.timeoutMs, 30_000),
        );

        // 3. Full backup: catalog has both rows + archived's snapshot; Restate has
        //    active's live K/V; streams have both histories.
        cli.backup(fullBackup);

        // 4. Reproduce §4.2 with the scripts ONLY: catalog+streams from the FULL
        //    backup, Restate from the EMPTY one ⇒ working set gone, archive intact.
        cli.restore(fullBackup, { postgres: true, streams: true });
        cli.restore(emptyBackup, { restate: true });

        // NOTE (documented operational step): wiping Restate also wiped the agent
        // service DEPLOYMENT registration in its metadata store, so nothing can be
        // woken until the agent deployment is re-registered against the fresh
        // Restate (T4.1's `teaspill dev`/serve). Provide that as
        // TEASPILL_BACKUP_REREGISTER_CMD; without it the operator must re-register
        // out-of-band before the assertions below can pass.
        cli.reregister();

        // 5a. ARCHIVED entity: a new message resurrects it from the catalog
        //     snapshot and it responds normally (resurrection is transparent).
        await driver.actions.send(archived.url, { text: "wake-again" });
        const archivedEvents = await driver.observeUntil(
          archived.streamUrl,
          (evs) =>
            evs.some(
              (e) =>
                e.type === "message" &&
                e.payload.role === "assistant" &&
                e.payload.content.some(
                  (b) => b.type === "text" && b.text.includes("wake-again"),
                ),
            ),
          { timeoutMs: Math.max(stack.timeoutMs, 60_000) },
        );
        expectInvariant(BACKUP_LOSSY_RESTORE.check(archivedEvents, { replyIncludes: "wake-again" }));

        // 5b. ACTIVE entity: its live K/V is gone and it has NO resurrectable
        //     snapshot (never archived). `handleMessage` throws the loud
        //     TerminalError SERVER-SIDE:
        //         noLiveStateTerminalError(active.url)
        //     The gateway send is one-way (202) so that error cannot travel back
        //     to this client — the observable proxy is that the entity NEVER
        //     produces a post-restore response. Assert it does not resurrect
        //     within a bounded window (the loud failure ⇒ no reply, not a hang).
        await driver.actions.send(active.url, { text: "active-wake" });
        await expect(
          driver.observeUntil(
            active.streamUrl,
            (evs) =>
              evs.some(
                (e) =>
                  e.type === "message" &&
                  e.payload.role === "assistant" &&
                  e.payload.content.some(
                    (b) => b.type === "text" && b.text.includes("active-wake"),
                  ),
              ),
            { timeoutMs: 15_000 },
          ),
        ).rejects.toThrow(/timed out/);
      },
      600_000,
    );
  },
);
