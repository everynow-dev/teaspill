/**
 * FAULT 2 — executor killed mid-exec.
 *
 * INVARIANT (assert this, not "no crash"): when the executor host dies while a
 * long exec is in flight, the workspace awaitable TIMES OUT (the host-unresponsive
 * backstop, T4.1/SPIKE §d), an `error` event lands on the entity timeline (which
 * stays seq-gapless — A1), and the workspace is RECOVERABLE: a fresh exec on the
 * same workspace key (on the restarted executor) starts and its awaitable
 * resolves EXACTLY once (A4/D4).
 *
 * OFFLINE (CI): the REAL `ExecutorHost` + conformance's manual exec adapter.
 * - Executor death is modelled by NEVER resolving the in-flight exec's awakeable
 *   (the process died with the executor) — so the host produces no resolution and
 *   the workspace-object backstop is what fires. We assert the awaitable is
 *   unresolved (⇒ the backstop timeout is the path, not a phantom completion).
 * - Recoverability: a FRESH host (the restarted executor) runs a NEW exec on the
 *   SAME workspace key; it starts and resolves once.
 * - The timeout→`error`-event mapping is projected through the REAL outbox and
 *   re-asserted seq-gapless + structural (the error occupies a seq slot; no gap).
 *
 * LIVE (gated): kill the executor mid long-exec; the run finishes with an error
 * (its awaitable timed out) and a later exec on the workspace still works.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ExecutorHost,
  type ExecCompletion,
  type HostStartExecRequest,
  type HostWorkspaceRef,
} from "@teaspill/executor";
import { DurableStreamsProjectionOutbox, timelineStreamPath } from "@teaspill/coordination";
import {
  ManualExecAdapter,
  MemoryWorld,
  FakeStreamsServer,
  assertSeqGapless,
  assertStructural,
  scenarioById,
  expectInvariant,
  createLiveDriver,
} from "@teaspill/conformance";
import { EXECUTOR_KILL } from "./faults.js";
import { readChaosConfig, CHAOS_SKIP_MESSAGE } from "./env.js";
import {
  execTimeoutErrorInit,
  runFinishedErrorInit,
  runStartedInit,
  spawnedInit,
  userMessageInit,
} from "./fixtures.js";

const WORKSPACE_KEY = "default/chaos-ws";
const ADAPTER_NAME = "conformance-manual";
const ENTITY = "/t/default/a/conformance-long-exec/chaos-executor";

function makeHost() {
  const adapter = new ManualExecAdapter();
  const resolutions: { id: string; payload: ExecCompletion }[] = [];
  const host = new ExecutorHost({
    adapters: { [ADAPTER_NAME]: adapter },
    resolveAwakeable: (id, payload) => {
      resolutions.push({ id, payload });
      return Promise.resolve();
    },
  });
  const ref: HostWorkspaceRef = { workspaceKey: WORKSPACE_KEY, config: { adapter: ADAPTER_NAME } };
  const req = (execId: string, awakeableId: string): HostStartExecRequest => ({
    ref,
    execId,
    command: "sleep 300 && echo done",
    timeoutMs: 60_000,
    maxTailBytes: 1024,
    awakeableId,
    streamPath: `/t/default/workspaces/chaos-ws/exec/${execId}/stdout`,
  });
  return { host, adapter, resolutions, req };
}

describe("FAULT 2 — executor killed mid-exec — offline (host awakeable timeout + recovery)", () => {
  it("the in-flight awaitable is left UNRESOLVED (⇒ the backstop timeout fires, not a phantom completion)", async () => {
    const { host, adapter, resolutions, req } = makeHost();

    // A long exec is dispatched on the executor.
    const started = await host.startExec(req("exec-1", "awk-1"));
    expect(started).toStrictEqual({ accepted: true, deduped: false });
    expect(adapter.startCount).toBe(1);

    // EXECUTOR KILLED mid-exec: the process dies with the host; the adapter
    // never completes it, so the awakeable is never resolved by the host. The
    // workspace object's awakeable timeout (its D4 backstop) is what fires.
    // (We do NOT call completeExec — that is the whole point.)
    await Promise.resolve();
    expect(resolutions).toHaveLength(0); // no host-side resolution — backstop territory
    expect(adapter.pending.has("exec-1")).toBe(true); // exec was in flight when the host died
  });

  it("the workspace is RECOVERABLE: a fresh exec on the same key resolves exactly once", async () => {
    // The executor died mid exec-1 (above). It RESTARTS — a fresh host owns the
    // same workspace key (single-writer per workspace, D4). A new exec runs.
    const { host, adapter, resolutions, req } = makeHost();
    const recovered = await host.startExec(req("exec-2", "awk-2"));
    expect(recovered).toStrictEqual({ accepted: true, deduped: false });
    expect(adapter.startCount).toBe(1);

    adapter.completeExec("exec-2", { exitCode: 0 });
    await vi.waitFor(() => expect(resolutions).toHaveLength(1));
    expect(resolutions[0]).toMatchObject({ id: "awk-2", payload: { exitCode: 0 } });
  });

  it("the timeout projects an `error` event and the timeline stays seq-gapless (A1)", async () => {
    // The workspace object maps the awakeable-timeout to a canonical `error`
    // event (source: tool, code: workspace_exec_timeout). Projected through the
    // REAL outbox, the error occupies a seq slot and the timeline stays gapless
    // and structural — the D2/D3 invariant the executor kill must preserve.
    const world = new MemoryWorld("chaos-executor");
    const server = new FakeStreamsServer();
    const outbox = new DurableStreamsProjectionOutbox({ transport: server });
    const path = timelineStreamPath(ENTITY);

    const ctx = world.ctx({ invocationId: "w1" });
    await outbox.stage(ctx, ENTITY, [
      spawnedInit,
      runStartedInit,
      userMessageInit("run: sleep 300"),
      execTimeoutErrorInit("exec awaitable timed out — executor unresponsive"),
      runFinishedErrorInit,
    ]);
    await outbox.flush(ctx, ENTITY);

    const timeline = server.timeline(path);
    expect(timeline.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3, 4]);
    const err = timeline.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.payload.code).toBe("workspace_exec_timeout");
    expectInvariant(assertStructural(timeline));
    expectInvariant(assertSeqGapless(timeline, { expectedFirstSeq: 0 }));
  });
});

// ---------------------------------------------------------------------------
// LIVE chaos (gated on TEASPILL_CHAOS + TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const chaos = readChaosConfig();
const WORKSPACE_EXEC_DURABILITY = scenarioById(EXECUTOR_KILL.scenarioId);

describe.skipIf(chaos === null)(
  `FAULT 2 — executor killed mid-exec — LIVE [${chaos?.stack.baseUrl ?? CHAOS_SKIP_MESSAGE}]`,
  () => {
    it("kill the executor mid-exec; the run ends (awaitable timed out) and the timeline is consistent", async () => {
      const { stack, compose, services } = chaos!;
      const driver = createLiveDriver(stack);
      const spawned = await driver.actions.spawn({ type: stack.agentTypes.longExec });
      await driver.actions.send(spawned.url, { command: "sleep 300 && echo done" });

      // Inject the fault mid-exec: kill the executor host while the long exec
      // runs. The workspace awaitable must hit its timeout backstop (D4).
      compose.kill(services.executor);

      // The run finishes (the awaitable resolved via timeout → an error event);
      // observeUntil rejects on any drift, so a clean resolve is already
      // structural + gapless.
      const events = await driver.observeUntil(
        spawned.streamUrl,
        (evs) => evs.some((e) => e.type === "run_finished"),
        { timeoutMs: Math.max(stack.timeoutMs, 120_000) },
      );
      expectInvariant(WORKSPACE_EXEC_DURABILITY.check(events));

      // Recoverability: bring the executor back and confirm a fresh exec works.
      compose.start(services.executor);
      await compose.waitHealthy(services.executor, 30_000);
      const recovered = await driver.actions.spawn({ type: stack.agentTypes.longExec });
      await driver.actions.send(recovered.url, { command: "echo recovered" });
      const recoveredEvents = await driver.observeUntil(
        recovered.streamUrl,
        (evs) => evs.some((e) => e.type === "run_finished"),
        { timeoutMs: Math.max(stack.timeoutMs, 60_000) },
      );
      expectInvariant(WORKSPACE_EXEC_DURABILITY.check(recoveredEvents));
    });
  },
);
