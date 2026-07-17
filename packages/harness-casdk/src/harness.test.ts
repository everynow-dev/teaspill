import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { TimelineEvent } from "@teaspill/schema";
import { finalizeEvent } from "@teaspill/schema";
import type { AnyToolDefinition, HarnessRunInput } from "@teaspill/harness-native";
import { toolIdempotencyKey } from "@teaspill/harness-native";
import { CasdkResumeMismatchError, createCasdkHarness, decideRunPlan, headSeq } from "./harness.js";
import { createMemorySessionStore, type CasdkSessionMeta } from "./session-store.js";
import { createFakeToolServer } from "./tool-seam.js";
import { PINNED_SDK_VERSION, type SdkStreamRecord } from "./sdk-client.js";
import {
  FIXTURE_ENTITY,
  assistantText,
  collectingDelta,
  createFakeSdkClient,
  emptySteerSource,
  fakeToolContextFactory,
  fixtureTimeline,
  resultSuccess,
  scriptedSteerSource,
  seqUuid,
  tickingNow,
} from "./testing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseMeta = (over: Partial<CasdkSessionMeta> = {}): CasdkSessionMeta => ({
  sessionId: "sess-1",
  seqStamp: 10,
  sdkVersion: PINNED_SDK_VERSION,
  idMap: { toSession: {}, toCanonical: {} },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function runInput(
  context: TimelineEvent[],
  over: Partial<HarnessRunInput> = {},
): { input: HarnessRunInput; deltas: ReturnType<typeof collectingDelta>["deltas"] } {
  const { deltas, emit } = collectingDelta();
  return {
    deltas,
    input: {
      entityId: FIXTURE_ENTITY,
      runId: "run-b",
      attempt: 0,
      canonicalContext: context,
      wakeMessage: null, // pre-commit convention: wake already in context
      tools: [],
      steerSource: emptySteerSource(),
      signal: new AbortController().signal,
      emitDelta: emit,
      ...over,
    },
  };
}

const textOfInput = (msg: { message: { content: unknown } }): string =>
  (msg.message.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("");

// ---------------------------------------------------------------------------
// decideRunPlan (pure trust-but-verify)
// ---------------------------------------------------------------------------

describe("decideRunPlan", () => {
  const ctx = fixtureTimeline(); // head = 11; seq11 = trailing user wake

  it("cold on: no meta / forceCold / version drift / missing lines / stamp ahead", () => {
    const base = { canonicalContext: ctx, sdkVersion: PINNED_SDK_VERSION, forceCold: false, hasLines: true };
    expect(decideRunPlan({ ...base, meta: null })).toMatchObject({ mode: "cold", reason: "no_session_meta" });
    expect(decideRunPlan({ ...base, meta: baseMeta(), forceCold: true })).toMatchObject({ mode: "cold", reason: "force_cold" });
    expect(decideRunPlan({ ...base, meta: baseMeta({ sdkVersion: "0.0.1" }) }).mode).toBe("cold");
    expect(decideRunPlan({ ...base, meta: baseMeta(), hasLines: false })).toMatchObject({ mode: "cold", reason: "session_lines_missing" });
    expect(decideRunPlan({ ...base, meta: baseMeta({ seqStamp: 99 }) })).toMatchObject({ mode: "cold", reason: "stamp_ahead_of_head" });
  });

  it("warm when stamp == head-1 and only the wake follows; feeds exactly the tail", () => {
    const plan = decideRunPlan({
      meta: baseMeta({ seqStamp: 10 }),
      canonicalContext: ctx,
      sdkVersion: PINNED_SDK_VERSION,
      forceCold: false,
      hasLines: true,
    });
    expect(plan).toMatchObject({ mode: "warm", sessionId: "sess-1" });
    expect(plan.mode === "warm" && plan.feedEvents.map((e) => e.seq)).toEqual([11]);
  });

  it("cold when an unfeedable event landed after the stamp", () => {
    const plan = decideRunPlan({
      meta: baseMeta({ seqStamp: 5 }), // tool_result@6, assistant@7 … after stamp
      canonicalContext: ctx,
      sdkVersion: PINNED_SDK_VERSION,
      forceCold: false,
      hasLines: true,
    });
    expect(plan.mode).toBe("cold");
    expect(plan.mode === "cold" && plan.reason).toMatch(/unfeedable_event_after_stamp/);
  });

  it("headSeq of empty context is -1", () => {
    expect(headSeq([])).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// The harness end-to-end against fakes
// ---------------------------------------------------------------------------

describe("createCasdkHarness", () => {
  it("rejects an unsupported sdkVersion at construction (R3)", () => {
    expect(() =>
      createCasdkHarness({
        store: createMemorySessionStore(),
        sdk: createFakeSdkClient({ respond: () => [] }),
        model: "m",
        sdkVersion: "1.2.3",
      }),
    ).toThrow(/no translation table/);
  });

  it("COLD first wake: projects, resumes the projected session, captures, stamps", async () => {
    const store = createMemorySessionStore();
    const sdk = createFakeSdkClient({
      respond: (msg) => [assistantText(`echo: ${textOfInput(msg)}`), resultSuccess()],
      mirror: true,
    });
    const harness = createCasdkHarness({
      store,
      sdk,
      model: "claude-haiku-4-5",
      systemPrompt: "sys",
      now: tickingNow(),
      newUuid: seqUuid("h"),
    });
    const ctx = fixtureTimeline();
    const { input } = runInput(ctx);
    const result = await harness.run(input);

    // Options carried the spike-verified minimum headless config.
    const call = sdk.calls[0]!;
    expect(call.options.tools).toEqual([]);
    expect(call.options.permissionMode).toBe("bypassPermissions");
    expect(call.options.settingSources).toEqual([]);
    expect(call.options.systemPrompt).toBe("sys");
    expect(call.options.sessionStoreFlush).toBe("eager");
    expect(call.options.resume).toBeDefined();

    // The SDK's load() got the projected transcript through the facade.
    expect(call.loadedLines?.length).toBeGreaterThan(0);
    // The wake (seq 11) was fed as streaming input, not projected.
    expect(call.fedInputs).toHaveLength(1);
    expect(textOfInput(call.fedInputs[0]!)).toBe("Now summarize our findings.");

    // Events: run_started, captured assistant message, run_finished.
    expect(result.events.map((e) => e.type)).toEqual(["run_started", "message", "run_finished"]);
    expect(result.events[0]).toMatchObject({ payload: { harness: "casdk", detail: { mode: "cold" } } });
    expect(result.events[2]).toMatchObject({ payload: { outcome: "success" } });

    // Predictive stamp: head(11) + 3 events = 14; meta saved; state mirrored.
    const meta = await store.loadMeta(FIXTURE_ENTITY);
    expect(meta).toMatchObject({ sessionId: call.sessionId, seqStamp: 14, sdkVersion: PINNED_SDK_VERSION });
    expect(meta!.pendingRun).toBeUndefined();
    expect(result.stateDelta.harness).toMatchObject({ sessionId: call.sessionId, seqStamp: 14, mode: "cold" });
    // The mirror appended through the facade into OUR store.
    const mirrored = await store.loadLines(FIXTURE_ENTITY, call.sessionId);
    expect(mirrored!.some((l) => l.uuid?.startsWith("fake-mirror"))).toBe(true);
  });

  it("WARM second wake: resumes the stored session without re-projection and feeds the tail", async () => {
    const store = createMemorySessionStore();
    const sdk = createFakeSdkClient({
      respond: () => [assistantText("warm answer"), resultSuccess()],
    });
    const harness = createCasdkHarness({ store, sdk, model: "m", now: tickingNow(), newUuid: seqUuid("h") });

    const ctx = fixtureTimeline(); // head 11, trailing wake @11
    await store.saveMeta(FIXTURE_ENTITY, baseMeta({ sessionId: "sess-w", seqStamp: 10 }));
    await store.replaceLines(FIXTURE_ENTITY, "sess-w", [
      { type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "prior" }] } },
    ]);

    const { input } = runInput(ctx);
    const result = await harness.run(input);

    const call = sdk.calls[0]!;
    expect(call.options.resume).toBe("sess-w"); // the SAME durable session
    expect(call.loadedLines?.map((l) => l.uuid)).toEqual(["u1"]); // no re-projection
    expect(textOfInput(call.fedInputs[0]!)).toBe("Now summarize our findings.");
    expect(result.events[0]).toMatchObject({ payload: { detail: { mode: "warm" } } });
    expect(result.stateDelta.harness).toMatchObject({ mode: "warm", sessionId: "sess-w", seqStamp: 14 });
  });

  it("WARM crashed-attempt retry: pendingRun marks the wake, retry re-feeds with a restart marker", async () => {
    const store = createMemorySessionStore();
    const ctx = fixtureTimeline();
    await store.saveMeta(FIXTURE_ENTITY, baseMeta({ sessionId: "sess-w", seqStamp: 10 }));
    await store.replaceLines(FIXTURE_ENTITY, "sess-w", [
      { type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "prior" }] } },
    ]);

    // Attempt 1: the subprocess dies mid-run (a non-abort failure).
    const crashing = createFakeSdkClient({
      respond: () => {
        throw new Error("subprocess died");
      },
    });
    const h1 = createCasdkHarness({ store, sdk: crashing, model: "m", now: tickingNow(), newUuid: seqUuid("h") });
    await expect(h1.run(runInput(ctx).input)).rejects.toThrow("subprocess died");
    // The in-flight marker was persisted BEFORE the query started.
    expect((await store.loadMeta(FIXTURE_ENTITY))!.pendingRun).toEqual({ runId: "run-b" });

    // Attempt 2 (same runId — a retried ctx.run): warm resume of the SAME
    // session; the wake re-feeds wrapped in an explicit restart marker.
    const sdk2 = createFakeSdkClient({ respond: () => [assistantText("recovered"), resultSuccess()] });
    const h2 = createCasdkHarness({ store, sdk: sdk2, model: "m", now: tickingNow(), newUuid: seqUuid("h2") });
    const result = await h2.run(runInput(ctx, { attempt: 1 }).input);

    const call = sdk2.calls[0]!;
    expect(call.options.resume).toBe("sess-w");
    expect(call.fedInputs).toHaveLength(1);
    const fed = textOfInput(call.fedInputs[0]!);
    expect(fed).toContain("process restarted");
    expect(fed).toContain("Now summarize our findings.");
    expect(result.events.map((e) => e.type)).toEqual(["run_started", "message", "run_finished"]);
    expect((await store.loadMeta(FIXTURE_ENTITY))!.pendingRun).toBeUndefined();
  });

  it("resume mismatch (silent fresh session) clears meta and rejects so the retry cold-rebuilds", async () => {
    const store = createMemorySessionStore();
    await store.saveMeta(FIXTURE_ENTITY, baseMeta({ sessionId: "sess-w", seqStamp: 10 }));
    await store.replaceLines(FIXTURE_ENTITY, "sess-w", [
      { type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "prior" }] } },
    ]);
    const sdk = createFakeSdkClient({
      sessionIdFor: () => "some-other-session",
      respond: () => [resultSuccess()],
    });
    const harness = createCasdkHarness({ store, sdk, model: "m", now: tickingNow(), newUuid: seqUuid("h") });
    await expect(harness.run(runInput(fixtureTimeline()).input)).rejects.toThrow(CasdkResumeMismatchError);
    expect(await store.loadMeta(FIXTURE_ENTITY)).toBeNull();
  });

  it("mirror_error taints the session: error event recorded, meta cleared (next wake cold)", async () => {
    const store = createMemorySessionStore();
    const sdk = createFakeSdkClient({
      respond: () => [
        { type: "system", subtype: "mirror_error", error: "batch dropped" } as SdkStreamRecord,
        assistantText("ok"),
        resultSuccess(),
      ],
    });
    const harness = createCasdkHarness({ store, sdk, model: "m", now: tickingNow(), newUuid: seqUuid("h") });
    const result = await harness.run(runInput(fixtureTimeline()).input);
    expect(result.events.some((e) => e.type === "error" && (e.payload as { code?: string }).code === "casdk_mirror_error")).toBe(true);
    expect(await store.loadMeta(FIXTURE_ENTITY)).toBeNull();
  });

  it("interrupt: a pre-aborted signal resolves normally with outcome interrupted (A8)", async () => {
    const store = createMemorySessionStore();
    const sdk = createFakeSdkClient({ respond: () => [assistantText("partial")] });
    const harness = createCasdkHarness({ store, sdk, model: "m", now: tickingNow(), newUuid: seqUuid("h") });
    const abort = new AbortController();
    abort.abort();
    const { input } = runInput(fixtureTimeline(), { signal: abort.signal });
    const result = await harness.run(input);
    const finished = result.events.at(-1)!;
    expect(finished).toMatchObject({ type: "run_finished", payload: { outcome: "interrupted" } });
  });

  it("steering: a steer drained at the turn boundary feeds the next turn and commits canonically", async () => {
    const store = createMemorySessionStore();
    const sdk = createFakeSdkClient({
      respond: (_msg, ctx) => [assistantText(`turn-${ctx.turn}`, `api-${ctx.turn}`), resultSuccess()],
    });
    const harness = createCasdkHarness({ store, sdk, model: "m", now: tickingNow(), newUuid: seqUuid("h") });
    const steer = scriptedSteerSource([
      [{ id: "steer-1", ts: "2026-01-01T00:00:10.000Z", content: [{ type: "text", text: "also check X" }] }],
    ]);
    const { input } = runInput(fixtureTimeline(), { steerSource: steer });
    const result = await harness.run(input);

    const call = sdk.calls[0]!;
    expect(call.fedInputs).toHaveLength(2);
    expect(textOfInput(call.fedInputs[1]!)).toBe("also check X");
    const types = result.events.map((e) => e.type);
    // run_started, turn-0 message, steer message, turn-1 message, run_finished
    expect(types).toEqual(["run_started", "message", "message", "message", "run_finished"]);
    expect(result.events[2]).toMatchObject({ payload: { id: "steer-1", role: "user" } });
    expect(steer.drains).toBe(2); // fed once, then empty → queue closed
  });

  it("Effects seam: tools execute through the fake tool server with the exactly-once key; detail back-fills", async () => {
    const store = createMemorySessionStore();
    const toolContext = fakeToolContextFactory();
    const toolServer = createFakeToolServer();
    const echoTool: AnyToolDefinition = {
      name: "echo",
      description: "echo",
      schema: z.object({ v: z.string() }),
      execute: async (inp: never) => ({
        content: [{ type: "text", text: (inp as { v: string }).v }],
        detail: { echoed: true },
      }),
    };
    const sdk = createFakeSdkClient({
      respond: async (_msg, ctx) => {
        // The scripted model calls the tool; the fake server executes it the
        // way T7.2's real MCP handler will (parse → ToolContext → detail).
        const exec = await toolServer.lastInstance!.execute("toolu_77", "echo", { v: "hi" });
        return [
          {
            type: "assistant",
            message: { id: `api-${ctx.turn}`, content: [{ type: "tool_use", id: "toolu_77", name: "mcp__teaspill__echo", input: { v: "hi" } }] },
            parent_tool_use_id: null,
          } as SdkStreamRecord,
          {
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_77", content: [{ type: "text", text: exec.text }] }] },
          } as SdkStreamRecord,
          assistantText("did it", `api-${ctx.turn}-b`),
          resultSuccess(),
        ];
      },
    });
    const harness = createCasdkHarness({
      store,
      sdk,
      toolServer,
      toolContext,
      model: "m",
      now: tickingNow(),
      newUuid: seqUuid("h"),
    });
    const { input } = runInput(fixtureTimeline(), { tools: [echoTool] });
    const result = await harness.run(input);

    // allowedTools carried the MCP-qualified name; mcpServers passed through.
    const call = sdk.calls[0]!;
    expect(call.options.allowedTools).toEqual(["mcp__teaspill__echo"]);
    expect(call.options.mcpServers).toEqual({ teaspill: { fake: true } });

    // The execution used the idempotency key contract (T3.1 invariant 1).
    expect(toolContext.calls).toEqual([
      { toolUseId: "toolu_77", idempotencyKey: toolIdempotencyKey(FIXTURE_ENTITY, "run-b", "toolu_77") },
    ]);

    // Capture back-filled detail from the tool layer (mapping §4.6).
    const toolResult = result.events.find((e) => e.type === "tool_result")!;
    expect(toolResult).toMatchObject({ payload: { toolUseId: "toolu_77", detail: { echoed: true } } });
  });

  it("fresh-entity wake (no transcript): starts without resume; SDK-minted session id is stamped", async () => {
    const store = createMemorySessionStore();
    const sdk = createFakeSdkClient({ respond: () => [assistantText("hello"), resultSuccess()] });
    const harness = createCasdkHarness({ store, sdk, model: "m", now: tickingNow(), newUuid: seqUuid("h") });
    const ctx = [
      finalizeEvent(
        { type: "entity_spawned", ts: "2026-01-01T00:00:00.000Z", payload: { entityType: "researcher", parentId: null } },
        { entityId: FIXTURE_ENTITY, seq: 0 },
      ),
      finalizeEvent(
        { type: "message", ts: "2026-01-01T00:00:01.000Z", payload: { id: "w", role: "user", content: [{ type: "text", text: "first" }] } },
        { entityId: FIXTURE_ENTITY, seq: 1 },
      ),
    ];
    const result = await harness.run(runInput(ctx).input);
    const call = sdk.calls[0]!;
    expect(call.options.resume).toBeUndefined();
    expect(call.sessionId).toMatch(/^fresh-/);
    expect((await store.loadMeta(FIXTURE_ENTITY))!.sessionId).toBe(call.sessionId);
    expect(result.stateDelta.harness).toMatchObject({ sessionId: call.sessionId, seqStamp: 1 + 3 });
  });
});
