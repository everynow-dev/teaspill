/**
 * Scenario 5 — workspace exec survives agent-loop restart. OFFLINE against the
 * REAL executor host (`ExecutorHost`) with a manually-driven adapter and a fake
 * awakeable resolver: a long exec is dispatched, the agent-loop replica
 * "restarts" (the workspace invocation is re-dispatched, and the host dedups
 * on `(workspaceKey, execId)` — the exec keeps running in the host plane, 0001:D4),
 * then the exec completes and the awaitable resolves EXACTLY ONCE regardless of
 * re-dispatch (0001:T4.1 awakeable durability, SPIKE §d). Plus a live-gated e2e.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ExecutorHost,
  type ExecCompletion,
  type HostStartExecRequest,
  type HostWorkspaceRef,
} from "@teaspill/executor";
import { WORKSPACE_EXEC_DURABILITY } from "./scenarios.js";
import { expectInvariant } from "./types.js";
import { ManualExecAdapter } from "./support/fake-adapter.js";
import { createLiveDriver, liveTestTimeout, readStackConfig, SKIP_MESSAGE } from "./live.js";

const WORKSPACE_KEY = "default/ws-1";
const ADAPTER_NAME = "conformance-manual";

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
    command: "sleep 30 && echo done",
    timeoutMs: 60_000,
    maxTailBytes: 1024,
    awakeableId,
    streamPath: `/t/default/workspaces/ws-1/exec/${execId}/stdout`,
  });
  return { host, adapter, resolutions, req };
}

describe("workspace exec survives agent-loop restart — offline (host awakeable)", () => {
  it("the awaitable resolves after the agent loop re-dispatches, and only once", async () => {
    const { host, adapter, resolutions, req } = makeHost();

    // Dispatch a long exec (does NOT complete yet).
    const first = await host.startExec(req("exec-1", "awk-1"));
    expect(first).toStrictEqual({ accepted: true, deduped: false });
    expect(adapter.startCount).toBe(1);
    expect(resolutions).toHaveLength(0); // still running

    // AGENT-LOOP RESTART: the workspace invocation is retried and re-dispatches
    // the SAME exec. The host dedups — the exec keeps running in the host plane;
    // no second process is started.
    const redispatch = await host.startExec(req("exec-1", "awk-1"));
    expect(redispatch).toStrictEqual({ accepted: true, deduped: true });
    expect(adapter.startCount).toBe(1); // NOT restarted
    expect(resolutions).toHaveLength(0); // still running

    // The exec completes in the host process — the awaitable resolves.
    adapter.completeExec("exec-1", { exitCode: 0 });
    await vi.waitFor(() => expect(resolutions).toHaveLength(1));
    expect(resolutions[0]).toMatchObject({ id: "awk-1", payload: { exitCode: 0 } });
  });

  it("a re-dispatch AFTER completion re-resolves idempotently (late/duplicate resolve is safe)", async () => {
    const { host, adapter, resolutions, req } = makeHost();
    await host.startExec(req("exec-2", "awk-2"));
    adapter.completeExec("exec-2", { exitCode: 0 });
    await vi.waitFor(() => expect(resolutions).toHaveLength(1));

    // Retry after the exec already finished: dedups AND re-resolves the same
    // awakeable with the same completion (SPIKE §d-3 — late resolve ignored).
    const again = await host.startExec(req("exec-2", "awk-2"));
    expect(again.deduped).toBe(true);
    await vi.waitFor(() => expect(resolutions).toHaveLength(2));
    expect(resolutions[0]).toStrictEqual(resolutions[1]); // same id + payload
  });
});

// ---------------------------------------------------------------------------
// Live end-to-end (skip-guarded on TEASPILL_STACK_URL)
// ---------------------------------------------------------------------------

const stack = readStackConfig();

describe.skipIf(stack === null)(
  `workspace exec durability — live e2e [${stack?.baseUrl ?? SKIP_MESSAGE}]`,
  () => {
    it("a long exec's run finishes (its awaitable resolved) after an agent-loop restart", async () => {
      // NOTE: restarting the agent-loop replica mid-exec is an out-of-band
      // operation the operator triggers while the long exec runs (see README).
      // The invariant: the run still finishes successfully — the awaitable
      // resolved despite the restart.
      const driver = createLiveDriver(stack!);
      const spawned = await driver.actions.spawn({ type: stack!.agentTypes.longExec });
      await driver.actions.send(spawned.url, { command: "sleep 5 && echo done" });
      // The SPAWN wake also emits a run_finished, so "some run_finished" would
      // pass VACUOUSLY before the exec even dispatches (0002:T4.2 live finding
      // — it did, while the exec itself was failing). Anchor the predicate on
      // the EXEC run: the assistant "exec finished" reply plus the
      // run_finished of that same run.
      const execReply = (evs: readonly import("@teaspill/schema").TimelineEvent[]) =>
        evs.find(
          (e) =>
            e.type === "message" &&
            e.payload.role === "assistant" &&
            e.payload.content.some((b) => b.type === "text" && b.text.includes("exec finished")),
        );
      const events = await driver.observeUntil(
        spawned.streamUrl,
        (evs) => {
          const reply = execReply(evs);
          if (reply === undefined || reply.type !== "message") return false;
          const runId = reply.payload.runId;
          return evs.some((e) => e.type === "run_finished" && e.payload.runId === runId);
        },
        { timeoutMs: Math.max(stack!.timeoutMs, 60_000) },
      );
      expectInvariant(WORKSPACE_EXEC_DURABILITY.check(events));
      const reply = execReply(events);
      expect(reply, "assistant exec-finished reply").toBeDefined();
      if (reply === undefined || reply.type !== "message") throw new Error("unreachable");
      const replyText = reply.payload.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      expect(replyText).toContain("exec finished (exit 0)");
      const finished = events.find(
        (e) => e.type === "run_finished" && e.payload.runId === reply.payload.runId,
      );
      expect(finished && finished.type === "run_finished" && finished.payload.outcome).toBe(
        "success",
      );
    }, liveTestTimeout(stack, stack === null ? undefined : Math.max(stack.timeoutMs, 60_000)));
  },
);
