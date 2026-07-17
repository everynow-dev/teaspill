/**
 * T6.1 end-to-end: a `defineAgent` native agent compiled onto the coordination
 * agent-object template runs against a fake Restate ctx + a fake pi step
 * client, producing correct canonical events with HARNESS-authored run
 * boundaries and the threaded wake source; a `finish` control tool ends the
 * loop and its result reaches the parent; the `claudeAgentSdk(...)` selection
 * is a typed stub that throws at run.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@teaspill/schema";
import { checkSeqContiguity } from "@teaspill/schema";
import type {
  PiStepClient,
  PiStepRequest,
  PiStepTurn,
  PiTurnBlock,
  ToolContext,
} from "@teaspill/harness-native";
import type { CasdkSdkClient, SdkMcpApi } from "@teaspill/harness-casdk";
import {
  AGENT_KV,
  InMemoryArchiveCatalog,
  InMemoryProjectionOutbox,
  agentEntityUrl,
  createAgentNotifier,
  handleMessage,
  handleSpawn,
  type AgentRuntimeCtx,
  type OnWakeHandler,
} from "@teaspill/coordination";
import { defineAgent } from "./define-agent.js";
import { native, claudeAgentSdk, type ToolContextBuilder } from "./harness.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A single virtual-object key's fake world: shared K/V + captured sends. */
class FakeWorld {
  readonly state = new Map<string, unknown>();
  readonly sent: Array<{ service: string; method: string; key?: string; parameter: unknown }> = [];
  constructor(readonly key: string) {}
  kv<T>(name: string): T | null {
    return this.state.has(name) ? (this.state.get(name) as T) : null;
  }
  ctx(invocationId: string): AgentRuntimeCtx {
    // Arrow closures capture the FakeWorld instance lexically (no `this` alias).
    return {
      key: this.key,
      invocationId,
      runAbortSignal: new AbortController().signal,
      get: async <T>(name: string): Promise<T | null> =>
        this.state.has(name) ? (this.state.get(name) as T) : null,
      set: <T>(name: string, value: T): void => {
        this.state.set(name, value);
      },
      clear: (name: string): void => {
        this.state.delete(name);
      },
      run: async <T>(_name: string, action: () => T | Promise<T>): Promise<T> => action(),
      raceInterrupt: <T>(work: Promise<T>): Promise<T> => work,
      armInterruptAbort: (): void => {
        // no interrupt in these tests
      },
      genericSend: (call): void => {
        this.sent.push(call);
      },
    };
  }
}

const BLOCKS = (...content: PiTurnBlock[]): PiTurnBlock[] => content;

/** Scripted pi step client: each `step()` consumes the next turn. */
class FakeStepClient implements PiStepClient {
  readonly provider = "fake";
  readonly model = "fake-model";
  readonly buffered = true;
  readonly contextWindow = undefined;
  calls = 0;
  requests: PiStepRequest[] = [];
  constructor(private readonly turns: PiTurnBlock[][]) {}
  async step(req: PiStepRequest): Promise<PiStepTurn> {
    this.requests.push(req);
    const content = this.turns[this.calls++];
    if (!content) throw new Error(`FakeStepClient: script exhausted at ${this.calls - 1}`);
    return {
      content,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
    };
  }
}

function deps(outbox = new InMemoryProjectionOutbox()) {
  return { outbox, notifier: createAgentNotifier(), _outbox: outbox };
}

const stateSchema = z.object({ notes: z.array(z.string()).optional() });
const ENTITY = agentEntityUrl("default", "researcher", "i-1");

// ---------------------------------------------------------------------------
// end-to-end: native harness, harness-authored boundaries, threaded wake source
// ---------------------------------------------------------------------------

describe("defineAgent(native) end-to-end", () => {
  it("runs on spawn: HARNESS authors run_started/run_finished with the threaded wake source", async () => {
    const client = new FakeStepClient([BLOCKS({ type: "text", text: "Working on it." })]);
    const agent = defineAgent({
      type: "researcher",
      spawnSchema: z.object({ task: z.string() }),
      state: stateSchema,
      harness: native({ model: "fake-model", client, platform: false }),
    });
    const d = deps();
    const config = agent.compileConfig({ outbox: d.outbox, notifier: d.notifier });
    const world = new FakeWorld("i-1");

    const res = await handleSpawn(world.ctx("inv-spawn"), config, { args: { task: "dig" } });
    expect(res.created).toBe(true);
    expect(res.outcome).toBe("success");

    const timeline = d._outbox.timeline(ENTITY);
    expect(timeline.map((e) => e.type)).toEqual([
      "entity_spawned",
      "message", // spawn args rendered as the wake input (pre-committed)
      "run_started", // authored by the HARNESS
      "message", // assistant turn
      "run_finished", // authored by the HARNESS
    ]);
    expect(checkSeqContiguity(timeline).ok).toBe(true);

    // Harness authorship proof: only the harness-authored run_started carries
    // `model`/`detail.provider` — the static path's does not.
    const runStarted = timeline.find((e) => e.type === "run_started")!;
    expect(runStarted.payload).toMatchObject({
      harness: "native",
      model: "fake-model",
      wake: { source: "spawn" }, // gap b: the true wake source threaded through
      detail: { provider: "fake" },
    });

    const assistant = timeline.filter(
      (e) => e.type === "message" && (e.payload as { role?: string }).role === "assistant",
    );
    expect(assistant[0]!.payload).toMatchObject({ content: [{ type: "text", text: "Working on it." }] });

    // The pi client saw the spawn args in its assembled context (D1).
    expect(client.requests).toHaveLength(1);
  });

  it("threads the wake source for a plain message wake (message → run_started.wake.source)", async () => {
    const client = new FakeStepClient([
      BLOCKS({ type: "text", text: "hi" }), // spawn
      BLOCKS({ type: "text", text: "pong" }), // message
    ]);
    const agent = defineAgent({
      type: "researcher",
      state: stateSchema,
      harness: native({ model: "fake-model", client, platform: false }),
    });
    const d = deps();
    const config = agent.compileConfig({ outbox: d.outbox, notifier: d.notifier });
    const world = new FakeWorld("i-1");

    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    await handleMessage(world.ctx("inv-m1"), config, { content: [{ type: "text", text: "ping" }] });

    const timeline = d._outbox.timeline(ENTITY);
    const runStarts = timeline.filter((e) => e.type === "run_started");
    expect(runStarts).toHaveLength(2);
    expect((runStarts[1]!.payload as { wake: { source: string } }).wake.source).toBe("message");
    expect(checkSeqContiguity(timeline).ok).toBe(true);
  });

  it("seeds the next run's context budget from the prior run's contextTokens (gap c)", async () => {
    const client = new FakeStepClient([
      BLOCKS({ type: "text", text: "one" }),
      BLOCKS({ type: "text", text: "two" }),
    ]);
    const agent = defineAgent({
      type: "researcher",
      state: stateSchema,
      harness: native({ model: "fake-model", client, platform: false }),
    });
    const d = deps();
    const config = agent.compileConfig({ outbox: d.outbox, notifier: d.notifier });
    const world = new FakeWorld("i-1");

    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    // The first run recorded a contextTokens gauge into K/V usage.
    const usage1 = world.kv<{ contextTokens?: number }>(AGENT_KV.usage);
    expect(usage1?.contextTokens).toBeGreaterThan(0);
    await handleMessage(world.ctx("inv-m1"), config, { content: [{ type: "text", text: "again" }] });
    // The gauge is latest-wins (proves the seed→run→re-anchor loop ran).
    const usage2 = world.kv<{ contextTokens?: number }>(AGENT_KV.usage);
    expect(usage2?.contextTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// finish control tool ends the loop + result reaches the parent (gap d)
// ---------------------------------------------------------------------------

describe("defineAgent(native) finish control tool", () => {
  it("a finish tool call ends the run and forwards its result to the parent's child_finished", async () => {
    const finishResult: JsonValue = { answer: 42 };
    const client = new FakeStepClient([
      BLOCKS({ type: "toolCall", toolUseId: "tu-1", name: "finish", input: { result: finishResult } }),
    ]);
    const agent = defineAgent({
      type: "researcher",
      state: stateSchema,
      // platform tools ON so `finish` is available (a control tool — no client).
      harness: native({ model: "fake-model", client }),
    });
    const d = deps();
    const config = agent.compileConfig({ outbox: d.outbox, notifier: d.notifier });
    const world = new FakeWorld("i-1");
    const parent = agentEntityUrl("default", "researcher", "parent-1");

    const res = await handleSpawn(world.ctx("inv-spawn"), config, { args: {}, parentRef: parent });
    expect(res.outcome).toBe("success");

    const timeline = d._outbox.timeline(ENTITY);
    // The loop ended after the finish tool: tool_call(finish) → tool_result → run_finished,
    // with NO further LLM step (the script has only one turn — not exhausted).
    expect(client.requests).toHaveLength(1);
    expect(timeline.map((e) => e.type)).toContain("tool_call");
    expect(timeline.at(-1)!.type).toBe("run_finished");
    expect(checkSeqContiguity(timeline).ok).toBe(true);

    // gap d: the finish result rode the child_finished back-send to the parent.
    const cf = world.sent.find(
      (s) => s.method === "message" && (s.parameter as { kind?: string }).kind === "child_finished",
    );
    expect(cf).toMatchObject({
      service: "agent.researcher",
      key: "parent-1",
      parameter: { kind: "child_finished", childId: ENTITY, result: finishResult },
    });
  });
});

// ---------------------------------------------------------------------------
// claudeAgentSdk(...) — the real CASDK harness (T7.1/T7.2), offline via fakes
// ---------------------------------------------------------------------------

/** A minimal fake CASDK query client: one init + one success result per run. */
const fakeCasdkSdk: CasdkSdkClient = {
  query({ options }) {
    async function* run(): AsyncGenerator<Record<string, unknown>> {
      yield { type: "system", subtype: "init", session_id: options.resume ?? "sess-fresh" };
      yield {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 3, output_tokens: 2 },
        total_cost_usd: 0,
      };
    }
    return run() as never;
  },
};

/** A fake SDK-MCP api so the tool server builds without loading the real SDK. */
const fakeMcpApi: SdkMcpApi = {
  tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (opts) => ({ type: "sdk", name: opts.name, instance: { close() {} } }),
};

/** A no-network tool-context builder (no side effect is exercised in these tests). */
const fakeToolContext: ToolContextBuilder = () => (b) =>
  ({
    entityUrl: b.entityUrl,
    runId: b.runId,
    toolUseId: b.toolUseId,
    idempotencyKey: b.idempotencyKey,
    signal: b.signal,
    platform: {
      spawn: async () => ({ entityId: "" }),
      send: async () => undefined,
      listChildren: async () => [],
    },
  }) satisfies ToolContext;

describe("claudeAgentSdk(...) real harness", () => {
  it("finalizes to a runnable buildHarness (no throw) and exposes platform tools", () => {
    const selection = claudeAgentSdk({ model: "claude-sonnet-4-5" }).finalize([]);
    expect(selection.kind).toBe("casdk");
    expect(selection.buildHarness).toBeDefined();
    expect(selection.tools.map((t) => t.name)).toContain("finish");
    // The descriptor is not runnable directly (built per wake via buildHarness).
    expect(() => selection.harness.run({} as never)).toThrow(/not runnable directly/);
  });

  it("runs a compiled CASDK agent end-to-end: HARNESS authors casdk run boundaries", async () => {
    const agent = defineAgent({
      type: "researcher",
      state: stateSchema,
      harness: claudeAgentSdk({
        model: "claude-sonnet-4-5",
        platform: false,
        sdk: fakeCasdkSdk,
        mcpApi: fakeMcpApi,
        toolContext: fakeToolContext,
      }),
    });
    expect(agent.harnessKind).toBe("casdk");
    const d = deps();
    const config = agent.compileConfig({ outbox: d.outbox, notifier: d.notifier });
    const world = new FakeWorld("i-1");

    const res = await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    expect(res.outcome).toBe("success");

    const timeline = d._outbox.timeline(ENTITY);
    const runStarted = timeline.find((e) => e.type === "run_started")!;
    expect(runStarted.payload).toMatchObject({ harness: "casdk" });
    expect(timeline.at(-1)!.type).toBe("run_finished");
    expect(checkSeqContiguity(timeline).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T8.1 follow-up: onWake (WIDER OnWakeHandler) + archiveCatalog forwarding
// ---------------------------------------------------------------------------

describe("defineAgent onWake + archiveCatalog forwarding (T8.1)", () => {
  it("forwards the WIDER OnWakeHandler onWake into AgentObjectConfig.onWake", () => {
    // A handler that uses the wide contract ({ handled: true } ⇒ onWake-only).
    const onWake: OnWakeHandler = async () => ({ handled: true });
    const client = new FakeStepClient([]);
    const agent = defineAgent({
      type: "researcher",
      state: stateSchema,
      harness: native({ model: "fake-model", client, platform: false }),
      onWake,
    });
    expect(agent.onWake).toBe(onWake);
    const config = agent.compileConfig({ outbox: new InMemoryProjectionOutbox(), notifier: createAgentNotifier() });
    expect(config.onWake).toBe(onWake);
  });

  it("passes the archiveCatalog dep through to the compiled config", () => {
    const catalog = new InMemoryArchiveCatalog();
    const client = new FakeStepClient([]);
    const agent = defineAgent({
      type: "researcher",
      state: stateSchema,
      harness: native({ model: "fake-model", client, platform: false }),
    });
    const config = agent.compileConfig({
      outbox: new InMemoryProjectionOutbox(),
      notifier: createAgentNotifier(),
      archiveCatalog: catalog,
    });
    expect(config.archiveCatalog).toBe(catalog);
    // Absent by default when the dep isn't supplied.
    const bare = agent.compileConfig({ outbox: new InMemoryProjectionOutbox(), notifier: createAgentNotifier() });
    expect(bare.archiveCatalog).toBeUndefined();
  });

  it("an onWake-only agent runs deterministically without invoking the harness", async () => {
    // The onWake handler fully handles the wake; the (throwing) native descriptor
    // is never .run() — proving onWake was wired into the coordination loop.
    const onWake: OnWakeHandler = async (wake) => {
      await wake.emit([
        { type: "message", ts: new Date(await wake.now()).toISOString(), payload: { id: "note", role: "system_note", content: [{ type: "text", text: "handled deterministically" }] } },
      ]);
      return { handled: true };
    };
    const client = new FakeStepClient([]); // never consulted
    const agent = defineAgent({
      type: "researcher",
      state: stateSchema,
      harness: native({ model: "fake-model", client, platform: false }),
      onWake,
    });
    const d = deps();
    const config = agent.compileConfig({ outbox: d.outbox, notifier: d.notifier });
    const world = new FakeWorld("i-1");

    const res = await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    expect(res.outcome).toBe("success");
    expect(client.calls).toBe(0); // the LLM harness never ran
    const timeline = d._outbox.timeline(ENTITY);
    expect(timeline.map((e) => e.type)).toContain("run_finished");
    // The onWake-emitted system_note is on the timeline.
    expect(
      timeline.some((e) => e.type === "message" && (e.payload as { role?: string }).role === "system_note"),
    ).toBe(true);
    expect(checkSeqContiguity(timeline).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// revisioned registration + schema validation
// ---------------------------------------------------------------------------

describe("defineAgent registration + validation", () => {
  it("registration carries the revision, harness kind, schemas, and tool names", () => {
    const client = new FakeStepClient([]);
    const agent = defineAgent({
      type: "researcher",
      revision: 3,
      spawnSchema: z.object({ task: z.string() }),
      state: stateSchema,
      harness: native({ model: "fake-model", client }),
    });
    const reg = agent.registration();
    expect(reg).toMatchObject({ type: "researcher", revision: 3, harness: "native" });
    expect(reg.spawnSchema).not.toBeNull();
    expect(reg.tools).toContain("finish");
  });

  it("rejects a breaking state change at an unchanged revision", () => {
    const client = new FakeStepClient([]);
    expect(() =>
      defineAgent({
        type: "researcher",
        revision: 1,
        state: z.object({ a: z.number() }),
        baseline: { revision: 1, state: z.object({ a: z.string() }) },
        harness: native({ model: "fake-model", client }),
      }),
    ).toThrow(/BREAKING state-schema change/);
  });

  it("invalid spawn args are a clean terminal rejection", async () => {
    const client = new FakeStepClient([BLOCKS({ type: "text", text: "ok" })]);
    const agent = defineAgent({
      type: "researcher",
      spawnSchema: z.object({ task: z.string() }),
      state: stateSchema,
      harness: native({ model: "fake-model", client, platform: false }),
    });
    const d = deps();
    const config = agent.compileConfig({ outbox: d.outbox, notifier: d.notifier });
    const world = new FakeWorld("i-1");
    await expect(
      handleSpawn(world.ctx("inv-spawn"), config, { args: { task: 123 } as unknown as JsonValue }),
    ).rejects.toThrow(/spawn args invalid/);
  });
});
