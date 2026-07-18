/**
 * The conformance agents, driven OFFLINE against the REAL coordination
 * handlers (`handleSpawn`/`handleMessage` over `MemoryWorld` +
 * `InMemoryProjectionOutbox`) and asserted with the ACTUAL conformance
 * scenario checks (`@teaspill/conformance` SCENARIOS) — the same `check`
 * functions 0002:T4.2's live runs will apply to these agents' timelines.
 * Loose gateway-shaped bodies (`{ text }`, `{ command }`) go through the
 * deployment's `validateMessage` normalization exactly as in production
 * (`compileLooseConfig`).
 */

import { describe, expect, it } from "vitest";
import {
  MemoryWorld,
  PARALLEL_FANOUT,
  SPAWN_RESPOND,
  WORKSPACE_EXEC_DURABILITY,
} from "@teaspill/conformance";
import {
  InMemoryProjectionOutbox,
  createAgentNotifier,
  handleMessage,
  handleSpawn,
  type AgentMessageInput,
  type AgentObjectConfig,
} from "@teaspill/coordination";
import type { TimelineEvent } from "@teaspill/schema";
import type { ExecOptions, ExecResult, WorkspaceClient } from "@teaspill/harness-native";
import type { AgentDefinition } from "@teaspill/agents-sdk";
import {
  CONFORMANCE_TYPES,
  echoAgent,
  fanoutChildAgent,
  fanoutParentAgent,
  lastUserText,
  longExecAgent,
  sanitizeInstanceId,
} from "./conformance-agents.js";
import { compileLooseConfig } from "./agent-loop.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function world(def: AgentDefinition, key: string) {
  const outbox = new InMemoryProjectionOutbox();
  const config: AgentObjectConfig = compileLooseConfig(def, {
    outbox,
    notifier: createAgentNotifier(),
  });
  const w = new MemoryWorld(key);
  const entityId = `/t/default/a/${def.type}/${key}`;
  const timeline = (): TimelineEvent[] => outbox.streams.get(entityId) ?? [];
  return { outbox, config, w, entityId, timeline };
}

/** A raw gateway-shaped message body (loose — exactly what the live driver sends). */
const loose = (body: Record<string, unknown>): AgentMessageInput =>
  body as unknown as AgentMessageInput;

class FakeWorkspaceClient implements WorkspaceClient {
  readonly workspaceRef = "default/fake";
  readonly execs: Array<{ cmd: string; opts?: ExecOptions }> = [];
  constructor(private readonly result: Partial<ExecResult> = {}) {}
  async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ cmd, ...(opts !== undefined && { opts }) });
    return { exitCode: 0, tail: "done", streamRef: "/t/default/workspaces/fake/exec/x/stdout", ...this.result };
  }
  async readFile(): Promise<string> {
    throw new Error("not used");
  }
  async writeFile(): Promise<void> {
    throw new Error("not used");
  }
  async ls(): Promise<string[]> {
    throw new Error("not used");
  }
  async mkdir(): Promise<void> {
    throw new Error("not used");
  }
  async rm(): Promise<void> {
    throw new Error("not used");
  }
  async stat(): Promise<{ kind: "file" | "dir"; size: number; mtimeMs: number }> {
    throw new Error("not used");
  }
}

// ---------------------------------------------------------------------------
// echo → spawn-respond (also the crash-resume / projection-continuity subject)
// ---------------------------------------------------------------------------

describe("conformance-echo", () => {
  it("satisfies SPAWN_RESPOND on a loose { text } send (the live driver's shape)", async () => {
    const { config, w, timeline } = world(echoAgent(), "e-1");
    await handleSpawn(w.ctx({ invocationId: "inv-spawn" }), config, {});
    await handleMessage(w.ctx({ invocationId: "inv-m1" }), config, loose({ text: "hello teaspill" }));

    const result = SPAWN_RESPOND.check(timeline(), { replyIncludes: "hello teaspill" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("echoes canonical content-block messages too", async () => {
    const { config, w, timeline } = world(echoAgent(), "e-2");
    await handleSpawn(w.ctx({ invocationId: "inv-spawn" }), config, {});
    await handleMessage(w.ctx({ invocationId: "inv-m1" }), config, {
      content: [{ type: "text", text: "ping" }],
    });
    const result = SPAWN_RESPOND.check(timeline(), { replyIncludes: "ping" });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fanout parent + child → parallel-fanout (the PERMANENT regression)
// ---------------------------------------------------------------------------

describe("conformance-fanout-parent", () => {
  it("spawns N children in ONE wake and satisfies PARALLEL_FANOUT after all child_finished land", async () => {
    const N = 4;
    const { config, w, entityId, timeline } = world(fanoutParentAgent(), "p-1");

    await handleSpawn(w.ctx({ invocationId: "inv-spawn" }), config, {
      args: { n: N, childType: CONFORMANCE_TYPES.fanoutChild },
    });

    // ONE wake fired N one-way spawn sends to agent.<childType>.
    const spawnSends = w.sent.filter(
      (s) => s.method === "spawn" && s.service === `agent.${CONFORMANCE_TYPES.fanoutChild}`,
    );
    expect(spawnSends).toHaveLength(N);
    // …and recorded N child_spawned events on its own timeline.
    const childIds = timeline()
      .filter((e): e is Extract<TimelineEvent, { type: "child_spawned" }> => e.type === "child_spawned")
      .map((e) => e.payload.childId);
    expect(childIds).toHaveLength(N);
    expect(new Set(childIds).size).toBe(N); // deterministic AND distinct

    // Deliver every child_finished (the platform-typed kind — untouched by
    // loose normalization) as its own wake.
    for (const [i, childId] of childIds.entries()) {
      await handleMessage(w.ctx({ invocationId: `inv-cf-${i}` }), config, {
        kind: "child_finished",
        childId,
        outcome: "success",
      });
    }

    const result = PARALLEL_FANOUT.check(timeline(), { childIds });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    void entityId;
  });

  it("rejects malformed spawn args with an error outcome (never a crash)", async () => {
    const { config, w, timeline } = world(fanoutParentAgent(), "p-2");
    // spawnSchema rejects at the handler (TerminalError) — n missing.
    await expect(
      handleSpawn(w.ctx({ invocationId: "inv-spawn" }), config, { args: { bogus: true } }),
    ).rejects.toThrow(/spawn args invalid/);
    expect(timeline()).toHaveLength(0); // nothing committed
  });
});

describe("conformance-fanout-child", () => {
  it("finishes immediately on spawn so the parent receives child_finished", async () => {
    const { config, w, timeline } = world(fanoutChildAgent(), "c-1");
    const parent = "/t/default/a/conformance-fanout-parent/p-1";
    await handleSpawn(w.ctx({ invocationId: "inv-spawn" }), config, { parentRef: parent });

    const finishes = timeline().filter((e) => e.type === "run_finished");
    expect(finishes).toHaveLength(1);
    // The child_finished back-send targeted the parent.
    const notes = w.sent.filter((s) => s.method === "message");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.parameter).toMatchObject({ kind: "child_finished", outcome: "success" });
  });
});

// ---------------------------------------------------------------------------
// long-exec → workspace-exec-durability
// ---------------------------------------------------------------------------

describe("conformance-long-exec", () => {
  it("runs the sent { command } through the workspace client and finishes after it resolves", async () => {
    const ws = new FakeWorkspaceClient({ exitCode: 0, tail: "done" });
    const binds: Array<{ entityUrl: string; runId: string }> = [];
    const def = longExecAgent({
      workspaceExec: (bind) => {
        binds.push(bind);
        return ws;
      },
    });
    const { config, w, timeline } = world(def, "x-1");
    await handleSpawn(w.ctx({ invocationId: "inv-spawn" }), config, {});
    await handleMessage(
      w.ctx({ invocationId: "inv-m1" }),
      config,
      loose({ command: "sleep 5 && echo done" }),
    );

    expect(ws.execs).toHaveLength(1);
    expect(ws.execs[0]!.cmd).toBe("sleep 5 && echo done");
    expect(binds[0]).toMatchObject({ entityUrl: "/t/default/a/conformance-long-exec/x-1" });

    const events = timeline();
    const result = WORKSPACE_EXEC_DURABILITY.check(events);
    expect(result.ok).toBe(true);
    const finished = events.filter((e) => e.type === "run_finished");
    // spawn wake + exec wake
    expect(finished).toHaveLength(2);
    expect(finished.every((e) => e.type === "run_finished" && e.payload.outcome === "success")).toBe(true);
  });

  it("a non-zero exit code surfaces as an error outcome", async () => {
    const ws = new FakeWorkspaceClient({ exitCode: 3, tail: "boom" });
    const def = longExecAgent({ workspaceExec: () => ws });
    const { config, w, timeline } = world(def, "x-2");
    await handleSpawn(w.ctx({ invocationId: "inv-spawn" }), config, {});
    await handleMessage(w.ctx({ invocationId: "inv-m1" }), config, loose({ command: "false" }));
    const finishes = timeline().filter(
      (e): e is Extract<TimelineEvent, { type: "run_finished" }> => e.type === "run_finished",
    );
    expect(finishes.at(-1)!.payload.outcome).toBe("error");
  });

  it("a body without { command } fails loudly (error outcome, teaching reply)", async () => {
    const def = longExecAgent({ workspaceExec: () => new FakeWorkspaceClient() });
    const { config, w, timeline } = world(def, "x-3");
    await handleSpawn(w.ctx({ invocationId: "inv-spawn" }), config, {});
    await handleMessage(w.ctx({ invocationId: "inv-m1" }), config, loose({ text: "run something" }));
    const events = timeline();
    expect(lastUserText(events)).toBe("run something");
    const finishes = events.filter(
      (e): e is Extract<TimelineEvent, { type: "run_finished" }> => e.type === "run_finished",
    );
    expect(finishes.at(-1)!.payload.outcome).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("sanitizeInstanceId", () => {
  it("derives addressing-charset-safe, deterministic ids", () => {
    expect(sanitizeInstanceId("inv_1ABCdef!@#", "c0")).toBe("c0-inv_1abcdef");
    expect(sanitizeInstanceId("inv_X", "c1")).toBe(sanitizeInstanceId("inv_X", "c1"));
    expect(sanitizeInstanceId("", "c2")).toBe("c2-x");
    expect(sanitizeInstanceId("a".repeat(100), "c3")).toHaveLength(64);
  });
});
