/**
 * PiHarness (0001:T3.2) step-durability tests — offline, against the two injected
 * seams: a FAKE `PiStepClient` (scripted turn/tool/error sequences) and a
 * FAKE `HarnessCtx` whose journal replays completed steps WITHOUT re-running
 * their closures (the Restate `ctx.run` replay contract, 0001:A4).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { finalizeEvent } from "@teaspill/schema";
import type { DeltaInit, TimelineEvent, TimelineEventInit } from "@teaspill/schema";
import { toolIdempotencyKey } from "./interface.js";
import { selectContextEvents } from "./context.js";
import type {
  HarnessRunInput,
  HarnessRunResult,
  PlatformClient,
  SteerMessage,
  SteerSource,
  ToolContext,
  ToolDefinition,
} from "./interface.js";
import { finishTool, setStatusTool } from "./tools.js";
import { PiProviderError } from "./pi-client.js";
import type {
  PiHistoryMessage,
  PiStepClient,
  PiStepDelta,
  PiStepRequest,
  PiStepTurn,
  PiTurnBlock,
  PiTurnUsage,
} from "./pi-client.js";
import { DEFAULT_SUMMARIZE_PROMPT, createPiHarness, toolInputSchemaOf } from "./pi-harness.js";
import type { HarnessCtx, ToolContextBinding, ToolContextFactory } from "./pi-harness.js";

const ENTITY = "/t/default/a/researcher/01jz00000000000000000000000";
const RUN_ID = "run-1";
const TS = "2026-07-17T12:00:00.000Z";

// ===========================================================================
// Fakes
// ===========================================================================

/** In-memory journal: completed steps replay by name without re-running. */
class FakeHarnessCtx implements HarnessCtx {
  journal = new Map<string, unknown>();
  /** Names whose closures actually EXECUTED (replays are not recorded). */
  executed: string[] = [];

  async run<T>(name: string, action: () => T | Promise<T>): Promise<T> {
    if (this.journal.has(name)) {
      return structuredClone(this.journal.get(name)) as T;
    }
    const value = await action();
    this.journal.set(name, structuredClone(value));
    this.executed.push(name);
    return value;
  }
}

type FakeScriptEntry =
  | {
      turn: {
        content: PiTurnBlock[];
        usage?: Partial<PiTurnUsage>;
        stopReason?: PiStepTurn["stopReason"];
      };
      deltas?: PiStepDelta[];
    }
  | { throw: unknown };

const BASE_USAGE: PiTurnUsage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 2 };

/** Scripted pi step client. Each `step()` consumes the next script entry. */
class FakeStepClient implements PiStepClient {
  readonly provider = "fake";
  readonly model = "fake-model";
  readonly buffered: boolean;
  readonly contextWindow: number | undefined;
  executions = 0;
  requests: Array<{
    messages: PiHistoryMessage[];
    tools: string[];
    systemPrompt: string | undefined;
    hadOnDelta: boolean;
  }> = [];

  constructor(
    public script: FakeScriptEntry[],
    opts: { buffered?: boolean; contextWindow?: number } = {},
  ) {
    this.buffered = opts.buffered ?? false;
    this.contextWindow = opts.contextWindow;
  }

  async step(req: PiStepRequest): Promise<PiStepTurn> {
    const i = this.executions++;
    this.requests.push({
      messages: structuredClone(req.messages) as PiHistoryMessage[],
      tools: req.tools.map((t) => t.name),
      systemPrompt: req.systemPrompt,
      hadOnDelta: req.onDelta !== undefined,
    });
    if (req.signal.aborted) {
      const err = new Error("step aborted");
      err.name = "AbortError";
      throw err;
    }
    const entry = this.script[i];
    if (!entry) throw new Error(`FakeStepClient: script exhausted at call ${i}`);
    if ("throw" in entry) throw entry.throw;
    if (entry.deltas && req.onDelta) {
      for (const d of entry.deltas) req.onDelta(d);
    }
    const content = entry.turn.content;
    return {
      content,
      usage: { ...BASE_USAGE, ...entry.turn.usage },
      stopReason:
        entry.turn.stopReason ?? (content.some((b) => b.type === "toolCall") ? "toolUse" : "stop"),
    };
  }
}

const fakePlatform: PlatformClient = {
  spawn: async () => ({ entityId: "/t/default/a/child/c1" }),
  send: async () => undefined,
  listChildren: async () => [],
};

function makeToolContextFactory(bindings: ToolContextBinding[]): ToolContextFactory {
  return (b) => {
    bindings.push(b);
    const ctx: ToolContext = {
      entityUrl: b.entityUrl,
      runId: b.runId,
      toolUseId: b.toolUseId,
      idempotencyKey: b.idempotencyKey,
      signal: b.signal,
      platform: fakePlatform,
    };
    return ctx;
  };
}

function makeEchoTool(
  calls: Array<{ input: unknown; ctx: ToolContext }>,
): ToolDefinition<{ text: string }> {
  return {
    name: "echo",
    description: "Echo the text back.",
    schema: z.object({ text: z.string() }).strict(),
    async execute(input, ctx) {
      calls.push({ input, ctx });
      return {
        content: [{ type: "text", text: `echo:${input.text}` }],
        detail: { echoed: input.text },
      };
    },
  };
}

/** Canonical context: consecutive-seq finalized events starting at seq 0. */
function canonical(...inits: TimelineEventInit[]): TimelineEvent[] {
  return inits.map((init, i) => finalizeEvent(init, { entityId: ENTITY, seq: i }));
}

const userMessageInit = (text: string, id = "wake-0"): TimelineEventInit => ({
  type: "message",
  ts: TS,
  payload: { id, role: "user", content: [{ type: "text", text }] },
});

interface Setup {
  ctx: FakeHarnessCtx;
  client: FakeStepClient;
  input: HarnessRunInput;
  committed: TimelineEventInit[][];
  /**
   * Finalized (seq-bearing) events the `commitEvents` seam allocated, in
   * commit order — the outbox's return value (0002:T3.2). Seqs continue from
   * the canonical context (next seq = `canonicalContext.length`), mirroring
   * the real outbox seq allocator (0001:A1).
   */
  finalized: TimelineEvent[];
  deltas: DeltaInit[];
  toolBindings: ToolContextBinding[];
  echoCalls: Array<{ input: unknown; ctx: ToolContext }>;
  run(over?: Partial<Parameters<typeof createPiHarness>[0]>): Promise<HarnessRunResult>;
}

function setup(opts: {
  script: FakeScriptEntry[];
  clientOpts?: { buffered?: boolean; contextWindow?: number };
  context?: TimelineEvent[];
  steerSource?: SteerSource;
  signal?: AbortSignal;
  tools?: ToolDefinition<never>[];
  noCommitSeam?: boolean;
  wakeMessage?: HarnessRunInput["wakeMessage"];
  harness?: Partial<Parameters<typeof createPiHarness>[0]>;
}): Setup {
  const ctx = new FakeHarnessCtx();
  const client = new FakeStepClient(opts.script, opts.clientOpts ?? {});
  const committed: TimelineEventInit[][] = [];
  const finalized: TimelineEvent[] = [];
  const deltas: DeltaInit[] = [];
  const toolBindings: ToolContextBinding[] = [];
  const echoCalls: Array<{ input: unknown; ctx: ToolContext }> = [];
  const tools = opts.tools ?? [makeEchoTool(echoCalls)];

  const canonicalContext = opts.context ?? canonical(userMessageInit("hello agent"));
  // The seam allocates seqs continuing from the canonical head (0001:A1).
  let nextSeq = canonicalContext.length;

  const input: HarnessRunInput = {
    entityId: ENTITY,
    runId: RUN_ID,
    attempt: 1,
    canonicalContext,
    wakeMessage: opts.wakeMessage ?? null,
    tools: tools as never,
    steerSource: opts.steerSource ?? { drain: async () => [] },
    signal: opts.signal ?? new AbortController().signal,
    emitDelta: (d) => deltas.push(d),
    ...(opts.noCommitSeam
      ? {}
      : {
          commitEvents: async (
            evts: readonly TimelineEventInit[],
          ): Promise<readonly TimelineEvent[]> => {
            committed.push([...evts]);
            const done = evts.map((init) =>
              finalizeEvent(init, { entityId: ENTITY, seq: nextSeq++ }),
            );
            finalized.push(...done);
            return done;
          },
        }),
  };

  const run = (over: Partial<Parameters<typeof createPiHarness>[0]> = {}) =>
    createPiHarness({
      ctx,
      client,
      toolContext: makeToolContextFactory(toolBindings),
      systemPrompt: "You are a test agent.",
      ...opts.harness,
      ...over,
    }).run(input);

  return { ctx, client, input, committed, finalized, deltas, toolBindings, echoCalls, run };
}

const flat = (committed: TimelineEventInit[][]): TimelineEventInit[] => committed.flat();
const types = (evts: TimelineEventInit[]): string[] => evts.map((e) => e.type);

// ===========================================================================
// (a) multi-step mapping + ordering (work/plans/0001-build-v1/notes/casdk-mapping.md §7)
// ===========================================================================

describe("multi-step run → canonical events (§7 mapping, in order)", () => {
  const script: FakeScriptEntry[] = [
    {
      turn: {
        content: [
          { type: "thinking", text: "let me think", signature: "sig-1" },
          { type: "text", text: "I'll echo that." },
          { type: "toolCall", toolUseId: "tu-1", name: "echo", input: { text: "hi" } },
        ],
      },
    },
    { turn: { content: [{ type: "text", text: "All done." }] } },
  ];

  it("commits run_started, reasoning, message, tool_call, tool_result, message, run_finished", async () => {
    const s = setup({ script });
    const result = await s.run();

    const evts = flat(s.committed);
    expect(types(evts)).toEqual([
      "run_started",
      "reasoning",
      "message",
      "tool_call",
      "tool_result",
      "message",
      "run_finished",
    ]);

    const [started, reasoning, msg0, toolCall, toolResult, msg1, finished] = evts as unknown[];
    expect((started as { payload: { runId: string; harness: string; model?: string } }).payload)
      .toMatchObject({ runId: RUN_ID, harness: "native", model: "fake-model" });
    expect((reasoning as { payload: { id: string; text: string } }).payload).toMatchObject({
      id: `rsn-${RUN_ID}-s0`,
      text: "let me think",
    });
    expect((msg0 as { payload: { id: string; role: string } }).payload).toMatchObject({
      id: `msg-${RUN_ID}-s0`,
      role: "assistant",
      content: [{ type: "text", text: "I'll echo that." }],
    });
    expect((toolCall as { payload: unknown }).payload).toMatchObject({
      runId: RUN_ID,
      toolUseId: "tu-1",
      name: "echo",
      input: { text: "hi" },
    });
    expect((toolResult as { payload: unknown }).payload).toMatchObject({
      runId: RUN_ID,
      toolUseId: "tu-1",
      name: "echo",
      content: [{ type: "text", text: "echo:hi" }],
      isError: false,
    });
    expect((msg1 as { payload: { id: string } }).payload.id).toBe(`msg-${RUN_ID}-s1`);
    expect((finished as { payload: unknown }).payload).toMatchObject({
      runId: RUN_ID,
      outcome: "success",
    });

    // Committed via the seam → NOT repeated in the result (0001:T3.1 invariant 3).
    expect(result.events).toEqual([]);
  });

  it("maps usage per §6: uncached input = input+cacheWrite; contextTokens = last step cache-inclusive", async () => {
    const s = setup({ script });
    const result = await s.run();
    expect(result.usage).toEqual({
      inputTokens: 24, // 2 steps × (10 input + 2 cacheWrite)
      outputTokens: 10, // 2 × 5
      cacheReadTokens: 40, // 2 × 20
      contextTokens: 32, // last step: 10 + 20 + 2
      steps: 2,
      attempt: 1,
    });
    expect(result.stateDelta.contextTokens).toBe(32);
    const finished = flat(s.committed).at(-1) as { payload: { usage: unknown } };
    expect(finished.payload.usage).toEqual(result.usage);
  });

  it("keeps the same-run assistant turn (incl. thinking + signature) in the next provider request", async () => {
    const s = setup({ script });
    await s.run();
    const secondReq = s.client.requests[1]!;
    const assistant = secondReq.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", text: "let me think", signature: "sig-1" },
      { type: "text", text: "I'll echo that." },
      { type: "toolCall", toolUseId: "tu-1", name: "echo", input: { text: "hi" } },
    ]);
    const toolResult = secondReq.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ toolUseId: "tu-1", isError: false });
  });

  it("without a commitEvents seam, the full event sequence is RETURNED instead", async () => {
    const s = setup({ script, noCommitSeam: true });
    const result = await s.run();
    expect(types(result.events)).toEqual([
      "run_started",
      "reasoning",
      "message",
      "tool_call",
      "tool_result",
      "message",
      "run_finished",
    ]);
    expect(s.committed).toEqual([]);
  });
});

// ===========================================================================
// (b) tool execution: injected ToolContext with the exactly-once key
// ===========================================================================

describe("tool-call step (exactly-once idempotency key)", () => {
  it("executes through the injected factory bound to toolIdempotencyKey(entityUrl, runId, toolUseId)", async () => {
    const s = setup({
      script: [
        {
          turn: {
            content: [{ type: "toolCall", toolUseId: "tu-9", name: "echo", input: { text: "k" } }],
          },
        },
        { turn: { content: [{ type: "text", text: "done" }] } },
      ],
    });
    await s.run();

    expect(s.toolBindings).toHaveLength(1);
    expect(s.toolBindings[0]).toMatchObject({
      entityUrl: ENTITY,
      runId: RUN_ID,
      toolUseId: "tu-9",
      idempotencyKey: toolIdempotencyKey(ENTITY, RUN_ID, "tu-9"),
    });
    expect(s.echoCalls).toHaveLength(1);
    expect(s.echoCalls[0]!.input).toEqual({ text: "k" }); // schema-parsed before execute
    expect(s.echoCalls[0]!.ctx.idempotencyKey).toBe(toolIdempotencyKey(ENTITY, RUN_ID, "tu-9"));
  });

  it("journals unknown-tool and invalid-input as isError tool_results (model-visible, run continues)", async () => {
    const s = setup({
      script: [
        {
          turn: {
            content: [
              { type: "toolCall", toolUseId: "tu-a", name: "no_such_tool", input: {} },
              { type: "toolCall", toolUseId: "tu-b", name: "echo", input: { wrong: true } },
            ],
          },
        },
        { turn: { content: [{ type: "text", text: "recovered" }] } },
      ],
    });
    const result = await s.run();
    const results = flat(s.committed).filter((e) => e.type === "tool_result") as Array<{
      payload: { toolUseId: string; isError: boolean };
    }>;
    expect(results.map((r) => [r.payload.toolUseId, r.payload.isError])).toEqual([
      ["tu-a", true],
      ["tu-b", true],
    ]);
    expect(s.echoCalls).toHaveLength(0); // invalid input never reaches execute
    expect(result.usage.steps).toBe(2);
  });

  it("(g) preserves image blocks in tool_result events AND the provider history", async () => {
    const imageTool: ToolDefinition<Record<string, never>> = {
      name: "screenshot",
      description: "Take a screenshot.",
      schema: z.object({}).strict(),
      async execute() {
        return {
          content: [
            { type: "text", text: "captured" },
            { type: "image", mimeType: "image/png", data: "aWJhc2U2NA==" },
          ],
        };
      },
    };
    const s = setup({
      script: [
        {
          turn: {
            content: [{ type: "toolCall", toolUseId: "tu-img", name: "screenshot", input: {} }],
          },
        },
        { turn: { content: [{ type: "text", text: "I see it." }] } },
      ],
      tools: [imageTool as never],
    });
    await s.run();

    const toolResult = flat(s.committed).find((e) => e.type === "tool_result") as {
      payload: { content: unknown[] };
    };
    expect(toolResult.payload.content).toEqual([
      { type: "text", text: "captured" },
      { type: "image", mimeType: "image/png", data: "aWJhc2U2NA==" },
    ]);
    // The image also survives into the NEXT step's provider messages.
    const history = s.client.requests[1]!.messages.find((m) => m.role === "toolResult");
    expect(history?.content).toEqual([
      { type: "text", text: "captured" },
      { type: "image", mimeType: "image/png", data: "aWJhc2U2NA==" },
    ]);
  });
});

// ===========================================================================
// (c) steer drained between steps
// ===========================================================================

describe("steerbox drained BEFORE each LLM step", () => {
  it("injects drained messages as canonical user events + provider input for the next step", async () => {
    const steerMsg: SteerMessage = {
      id: "steer-7",
      ts: TS,
      content: [{ type: "text", text: "change course" }],
      from: "/t/default/a/operator/op1",
    };
    let drains = 0;
    const s = setup({
      script: [
        {
          turn: {
            content: [{ type: "toolCall", toolUseId: "tu-1", name: "echo", input: { text: "x" } }],
          },
        },
        { turn: { content: [{ type: "text", text: "steered" }] } },
      ],
      steerSource: {
        drain: async () => (++drains === 2 ? [steerMsg] : []),
      },
    });
    await s.run();

    const evts = flat(s.committed);
    expect(types(evts)).toEqual([
      "run_started",
      "tool_call", // step 0 is a tool-only turn (no assistant text)
      "tool_result",
      "message", // ← the drained steer, committed at the step-1 boundary
      "message", // step-1 assistant
      "run_finished",
    ]);
    const steerEvent = evts.find(
      (e) => e.type === "message" && (e.payload as { id: string }).id === "steer-7",
    ) as { payload: { role: string; from?: string } };
    expect(steerEvent.payload).toMatchObject({ role: "user", from: steerMsg.from });

    // The next LLM step saw it as the LAST user input.
    const lastMsg = s.client.requests[1]!.messages.at(-1)!;
    expect(lastMsg).toEqual({
      role: "user",
      content: [{ type: "text", text: "change course" }],
    });
    // The steer did NOT abort the in-flight generation (documented choice):
    // both scripted turns executed exactly once, in order.
    expect(s.client.executions).toBe(2);
  });
});

// ===========================================================================
// (d) context budget → summarization via its own ctx.run
// ===========================================================================

describe("context budget → summarization", () => {
  it("over budget: summarizes via its own journaled LLM call and folds the canonical prefix", async () => {
    const s = setup({
      script: [
        { turn: { content: [{ type: "text", text: "COMPACT SUMMARY." }] } }, // summarizer
        { turn: { content: [{ type: "text", text: "continuing" }] } }, // the real step
      ],
      context: canonical(
        userMessageInit("a long conversation history ".repeat(20), "m0"),
        {
          type: "message",
          ts: TS,
          payload: {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "previous reply ".repeat(20) }],
          },
        },
      ),
      harness: { contextBudgetTokens: 10 },
    });
    const result = await s.run();

    // The summary was its OWN journaled step, before the LLM step.
    expect(s.ctx.executed).toContain("pi:summarize-0");
    expect(s.ctx.executed.indexOf("pi:summarize-0")).toBeLessThan(
      s.ctx.executed.indexOf("pi:llm-0"),
    );

    // The summarizer call: no tools, summarize instruction as final user message.
    const sumReq = s.client.requests[0]!;
    expect(sumReq.tools).toEqual([]);
    expect(sumReq.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: DEFAULT_SUMMARIZE_PROMPT }],
    });

    // Canonical summarization event: folds through the last context-bearing seq (1).
    const evts = flat(s.committed);
    expect(types(evts)).toEqual(["run_started", "summarization", "message", "run_finished"]);
    const summarization = evts[1] as {
      payload: { summary: string; replacesThroughSeq: number; detail?: { trigger?: string } };
    };
    expect(summarization.payload.summary).toBe("COMPACT SUMMARY.");
    expect(summarization.payload.replacesThroughSeq).toBe(1);
    expect(summarization.payload.detail).toMatchObject({ trigger: "context_budget" });

    // The folded context replaced the canonical prefix with the summary note.
    const stepReq = s.client.requests[1]!;
    expect(stepReq.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "[conversation summary] COMPACT SUMMARY." }],
    });
    expect(stepReq.messages).toHaveLength(1);

    // The summarizer LLM call is counted in usage.
    expect(result.usage.steps).toBe(2);
  });

  it("a run over budget TWICE folds TWICE, replacesThroughSeq correct both times, latest fold wins (0002:T3.2)", async () => {
    const s = setup({
      script: [
        { turn: { content: [{ type: "text", text: "SUMMARY ONE" }] } }, // fold-1 summarizer
        {
          // llm-0: keeps context over budget via a large usage anchor, and a
          // tool call so the loop reaches step 1 (where fold-2 fires).
          turn: {
            content: [
              { type: "text", text: "working" },
              { type: "toolCall", toolUseId: "tu-1", name: "echo", input: { text: "x" } },
            ],
            usage: { input: 100 },
          },
        },
        { turn: { content: [{ type: "text", text: "SUMMARY TWO" }] } }, // fold-2 summarizer
        { turn: { content: [{ type: "text", text: "done" }] } }, // llm-1: ends the run
      ],
      context: canonical(
        userMessageInit("a long conversation history ".repeat(20), "m0"),
        {
          type: "message",
          ts: TS,
          payload: {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "previous reply ".repeat(20) }],
          },
        },
      ),
      harness: { contextBudgetTokens: 10 },
    });
    const result = await s.run();

    // Both folds happened, in order, each as its own journaled LLM call.
    expect(s.ctx.executed).toContain("pi:summarize-0");
    expect(s.ctx.executed).toContain("pi:summarize-1");
    expect(result.usage.steps).toBe(4); // 2 summarizers + 2 real LLM steps

    const evts = flat(s.committed);
    expect(types(evts)).toEqual([
      "run_started",
      "summarization", // fold 1
      "message", // llm-0 assistant text
      "tool_call",
      "tool_result",
      "summarization", // fold 2
      "message", // llm-1 "done"
      "run_finished",
    ]);

    // replacesThroughSeq is correct for BOTH folds: fold 1 covers only the
    // canonical prefix (last context-bearing seq 1); fold 2 advances past the
    // mid-run events the seam allocated seqs to (incl. fold 1's own
    // summarization at seq 3, the assistant msg 4, tool_call 5, tool_result 6).
    const summarizations = evts.filter((e) => e.type === "summarization") as Array<{
      payload: { summary: string; replacesThroughSeq: number };
    }>;
    expect(summarizations.map((sm) => sm.payload.summary)).toEqual(["SUMMARY ONE", "SUMMARY TWO"]);
    expect(summarizations.map((sm) => sm.payload.replacesThroughSeq)).toEqual([1, 6]);

    // The seam allocated contiguous ascending seqs (0001:A1) — seed the fold
    // reconstruction from them.
    expect(s.finalized.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);

    // Latest fold wins in context assembly: over the FULL timeline, only the
    // second summarization (seq 7) and the events strictly after seq 6 survive.
    const timeline = [...s.input.canonicalContext, ...s.finalized];
    const selected = selectContextEvents(timeline);
    expect(selected.map((e) => e.type)).toEqual(["summarization", "message"]);
    expect((selected[0] as { payload: { summary: string } }).payload.summary).toBe("SUMMARY TWO");
    expect(
      (selected[1] as { payload: { content: { text: string }[] } }).payload.content[0]!.text,
    ).toBe("done");
  });

  it("under budget: no summarization step, no summarization event", async () => {
    const s = setup({
      script: [{ turn: { content: [{ type: "text", text: "hi" }] } }],
      clientOpts: { contextWindow: 200_000 },
    });
    await s.run();
    expect(s.ctx.executed.filter((n) => n.startsWith("pi:summarize"))).toEqual([]);
    expect(types(flat(s.committed))).toEqual(["run_started", "message", "run_finished"]);
  });
});

// ===========================================================================
// (e) provider errors: terminal vs retryable
// ===========================================================================

describe("provider error classification", () => {
  it("terminal error → error(source:'provider') + run_finished(outcome:'error'); run RESOLVES", async () => {
    const s = setup({
      script: [
        {
          throw: new PiProviderError({
            code: "PROVIDER_AUTH_FAILED",
            message: "401 invalid api key",
          }),
        },
      ],
    });
    const result = await s.run();
    const evts = flat(s.committed);
    expect(types(evts)).toEqual(["run_started", "error", "run_finished"]);
    expect((evts[1] as { payload: unknown }).payload).toMatchObject({
      runId: RUN_ID,
      code: "PROVIDER_AUTH_FAILED",
      source: "provider",
    });
    expect((evts[2] as { payload: { outcome: string } }).payload.outcome).toBe("error");
    expect(result.usage.steps).toBe(0); // the failed call journaled as failed — never re-billed
  });

  it("retryable error → RETHROWN out of the step (Restate retries); the step did NOT journal", async () => {
    const s = setup({
      script: [
        { throw: new PiProviderError({ code: "PROVIDER_RATE_LIMITED", message: "429 slow down" }) },
        { turn: { content: [{ type: "text", text: "recovered" }] } },
      ],
    });
    await expect(s.run()).rejects.toThrow(/429 slow down/);
    expect(types(flat(s.committed))).toEqual(["run_started"]); // nothing terminal committed
    expect(s.ctx.journal.has("pi:llm-0")).toBe(false); // failed step left un-journaled

    // Simulated Restate retry: same journal, same client — the retried run
    // replays pi:start/steer-0 and re-runs ONLY the failed LLM step.
    const result = await s.run();
    expect(result.usage.steps).toBe(1);
    expect(s.client.executions).toBe(2); // one failed + one successful — no extra calls
    expect(types(flat(s.committed)).slice(1)).toEqual(["run_started", "message", "run_finished"]);
  });

  it("classifies unclassifiable client throws as terminal provider errors", async () => {
    const s = setup({ script: [{ throw: new Error("something exotic exploded") }] });
    await s.run();
    const error = flat(s.committed)[1] as { payload: { code: string; source: string } };
    expect(error.payload).toMatchObject({ code: "PROVIDER_ERROR", source: "provider" });
  });
});

// ===========================================================================
// (f) replay safety — completed steps never re-run, LLM calls never re-billed
// ===========================================================================

describe("replay safety (fake-ctx journal)", () => {
  it("a crash after step 0 → the retried run replays step 0 from the journal (no re-bill, no tool re-run)", async () => {
    let healed = false;
    let drains = 0;
    const s = setup({
      script: [
        {
          turn: {
            content: [{ type: "toolCall", toolUseId: "tu-1", name: "echo", input: { text: "a" } }],
          },
        },
        { turn: { content: [{ type: "text", text: "after crash" }] } },
      ],
      steerSource: {
        drain: async () => {
          drains += 1;
          if (drains === 2 && !healed) throw new Error("transient: steerbox unreachable");
          return [];
        },
      },
    });

    // Attempt 1: llm-0 + tool ran, then the steer drain for step 1 crashed.
    await expect(s.run()).rejects.toThrow(/steerbox unreachable/);
    expect(s.client.executions).toBe(1);
    expect(s.echoCalls).toHaveLength(1);
    const executedFirst = [...s.ctx.executed];
    expect(executedFirst).toEqual(["pi:start", "pi:steer-0", "pi:llm-0", "pi:tool-0-0"]);

    // Attempt 2 (Restate retry): same journal. Completed steps replay without
    // executing; only the crashed drain and the NEW step run.
    healed = true;
    const result = await s.run();
    expect(result.usage.steps).toBe(2);
    expect(s.client.executions).toBe(2); // step 0 was NOT re-billed
    expect(s.echoCalls).toHaveLength(1); // the tool was NOT re-executed
    expect(s.ctx.executed.slice(executedFirst.length)).toEqual([
      "pi:steer-1",
      "pi:llm-1",
      "pi:end",
    ]);

    // The retried attempt still commits the complete, correctly ordered
    // sequence (the outbox dedups re-commits by seq — 0001:A6 reader rule).
    const attempt2 = s.committed.slice(
      s.committed.findIndex((b, i) => i > 0 && b[0]?.type === "run_started"),
    );
    expect(types(flat(attempt2))).toEqual([
      "run_started",
      "tool_call", // step 0 replayed from the journal — same events re-committed
      "tool_result",
      "message", // step 1 (fresh)
      "run_finished",
    ]);
  });
});

// ===========================================================================
// Interrupt (0001:A4/0001:A8), control tools, deltas, guards
// ===========================================================================

describe("interrupt via signal", () => {
  it("an abort mid-run resolves normally with run_finished(outcome:'interrupted')", async () => {
    const controller = new AbortController();
    const abortingTool: ToolDefinition<Record<string, never>> = {
      name: "long_task",
      description: "A tool during which the interrupt verb fires.",
      schema: z.object({}).strict(),
      async execute() {
        controller.abort();
        return { content: [{ type: "text", text: "partial work" }] };
      },
    };
    const s = setup({
      script: [
        {
          turn: {
            content: [{ type: "toolCall", toolUseId: "tu-1", name: "long_task", input: {} }],
          },
        },
      ],
      tools: [abortingTool as never],
      signal: controller.signal,
    });
    const result = await s.run();

    const evts = flat(s.committed);
    expect(types(evts)).toEqual([
      "run_started",
      "tool_call",
      "tool_result",
      "run_finished",
    ]);
    expect((evts.at(-1) as { payload: { outcome: string } }).payload.outcome).toBe("interrupted");
    expect(s.client.executions).toBe(1); // no further LLM step after the abort
    expect(result.usage.steps).toBe(1);
  });
});

describe("platform control tools end the loop", () => {
  it("finish → loop ends, outcome success, control surfaced on run_finished.detail", async () => {
    const s = setup({
      script: [
        {
          turn: {
            content: [
              {
                type: "toolCall",
                toolUseId: "tu-f",
                name: "finish",
                input: { result: { ok: true } },
              },
            ],
          },
        },
      ],
      tools: [finishTool() as never],
    });
    await s.run();
    const finished = flat(s.committed).at(-1) as {
      payload: { outcome: string; detail?: { control?: { kind: string; result?: unknown } } };
    };
    expect(finished.payload.outcome).toBe("success");
    expect(finished.payload.detail?.control).toEqual({ kind: "finish", result: { ok: true } });
    expect(s.client.executions).toBe(1);
  });

  it("set_status does NOT end the loop; the last status lands on run_finished.detail", async () => {
    const s = setup({
      script: [
        {
          turn: {
            content: [
              {
                type: "toolCall",
                toolUseId: "tu-s",
                name: "set_status",
                input: { status: "researching" },
              },
            ],
          },
        },
        { turn: { content: [{ type: "text", text: "done" }] } },
      ],
      tools: [setStatusTool() as never],
    });
    await s.run();
    const finished = flat(s.committed).at(-1) as {
      payload: { outcome: string; detail?: { status?: string } };
    };
    expect(finished.payload.outcome).toBe("success");
    expect(finished.payload.detail?.status).toBe("researching");
    expect(s.client.executions).toBe(2);
  });
});

describe("token deltas (out-of-band, fire-and-forget)", () => {
  it("streams text/reasoning/tool_input deltas with deterministic refs and per-ref idx", async () => {
    const s = setup({
      script: [
        {
          turn: { content: [{ type: "text", text: "hello" }] },
          deltas: [
            { kind: "text", text: "hel" },
            { kind: "text", text: "lo" },
            { kind: "reasoning", text: "hmm" },
            { kind: "tool_input", toolUseId: "tu-1", text: "{" },
            { kind: "tool_input", text: "orphan" }, // no ref → dropped
          ],
        },
      ],
    });
    await s.run();
    expect(
      s.deltas.map((d) => ({ kind: d.kind, ref: d.ref, idx: d.idx, attempt: d.attempt })),
    ).toEqual([
      { kind: "text", ref: `msg-${RUN_ID}-s0`, idx: 0, attempt: 1 },
      { kind: "text", ref: `msg-${RUN_ID}-s0`, idx: 1, attempt: 1 },
      { kind: "reasoning", ref: `rsn-${RUN_ID}-s0`, idx: 0, attempt: 1 },
      { kind: "tool_input", ref: "tu-1", idx: 0, attempt: 1 },
    ]);
  });

  it("a buffered client gets no onDelta and emits no deltas (journal granularity unchanged)", async () => {
    const s = setup({
      script: [{ turn: { content: [{ type: "text", text: "whole" }] } }],
      clientOpts: { buffered: true },
    });
    await s.run();
    expect(s.client.requests[0]!.hadOnDelta).toBe(false);
    expect(s.deltas).toEqual([]);
    // The finalized event still lands — buffering silences only the deltas.
    expect(types(flat(s.committed))).toEqual(["run_started", "message", "run_finished"]);
  });
});

describe("guards", () => {
  it("maxSteps exceeded → error(source:'harness') + run_finished(outcome:'error')", async () => {
    const s = setup({
      script: [
        {
          turn: {
            content: [{ type: "toolCall", toolUseId: "tu-1", name: "echo", input: { text: "x" } }],
          },
        },
      ],
      harness: { maxSteps: 1 },
    });
    await s.run();
    const evts = flat(s.committed);
    expect(types(evts)).toEqual([
      "run_started",
      "tool_call",
      "tool_result",
      "error",
      "run_finished",
    ]);
    expect((evts[3] as { payload: unknown }).payload).toMatchObject({
      code: "max_steps_exceeded",
      source: "harness",
    });
    expect((evts.at(-1) as { payload: { outcome: string } }).payload.outcome).toBe("error");
  });

  it("emitRunBoundaries:false suppresses run_started/run_finished (handler-authored wiring)", async () => {
    const s = setup({
      script: [{ turn: { content: [{ type: "text", text: "hi" }] } }],
      harness: { emitRunBoundaries: false },
    });
    await s.run();
    expect(types(flat(s.committed))).toEqual(["message"]);
  });

  it("a non-null wakeMessage is committed and joins the provider context", async () => {
    const s = setup({
      script: [{ turn: { content: [{ type: "text", text: "hi" }] } }],
      wakeMessage: {
        source: "message",
        content: [{ type: "text", text: "fresh wake" }],
        from: "/t/default/a/parent/p1",
      },
    });
    await s.run();
    const wake = flat(s.committed).find(
      (e) => e.type === "message" && (e.payload as { id: string }).id === `wake-${RUN_ID}`,
    ) as { payload: { role: string; from?: string } };
    expect(wake.payload).toMatchObject({ role: "user", from: "/t/default/a/parent/p1" });
    expect(s.client.requests[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "fresh wake" }],
    });
  });
});

// ===========================================================================
// toolInputSchemaOf
// ===========================================================================

describe("toolInputSchemaOf", () => {
  it("derives a strict JSON schema from a tool's zod schema (recursive JsonValue included)", () => {
    const schema = toolInputSchemaOf(finishTool() as never) as {
      type: string;
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual(["result", "summary"]);
  });
});
