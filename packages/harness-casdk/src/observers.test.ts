/**
 * T7.2 — hooks are OBSERVERS ONLY (D5). Two guarantees, both tested here:
 *
 * 1. The run wires NO gating hooks. `tools: []` + `permissionMode:
 *    'bypassPermissions'` mean teaspill owns every tool, so the query never
 *    registers a PreToolUse / PostToolUse / permission hook that could block or
 *    redirect a call. The only hook is `PostCompact` — the sole source of the
 *    SDK's compaction summary text (digest §1.3), a pure observer returning
 *    `{}`.
 * 2. Finalized events + token deltas are extracted LIVE from the message stream
 *    (partial-message → deltas; assistant/user records → finalized tool_call /
 *    tool_result) — never from a hook, and never gated by one.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AnyToolDefinition, HarnessRunInput } from "@teaspill/harness-native";
import { createCasdkHarness } from "./harness.js";
import { createMemorySessionStore } from "./session-store.js";
import { createFakeToolServer } from "./tool-seam.js";
import type { SdkStreamRecord } from "./sdk-client.js";
import {
  FIXTURE_ENTITY,
  collectingDelta,
  createFakeSdkClient,
  emptySteerSource,
  fakeToolContextFactory,
  resultSuccess,
  seqUuid,
  tickingNow,
} from "./testing.js";

const echoTool: AnyToolDefinition = {
  name: "echo",
  description: "echo",
  schema: z.object({ text: z.string() }),
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
} as unknown as AnyToolDefinition;

function runInput(over: Partial<HarnessRunInput> = {}): {
  input: HarnessRunInput;
  deltas: ReturnType<typeof collectingDelta>["deltas"];
} {
  const { deltas, emit } = collectingDelta();
  return {
    deltas,
    input: {
      entityId: FIXTURE_ENTITY,
      runId: "run-obs",
      attempt: 0,
      canonicalContext: [],
      wakeMessage: { source: "message", content: [{ type: "text", text: "hi" }] },
      tools: [echoTool],
      steerSource: emptySteerSource(),
      signal: new AbortController().signal,
      emitDelta: emit,
      ...over,
    },
  };
}

describe("hooks as observers only", () => {
  it("wires PostCompact (observer) and NO gating hook; the run is never blocked by a hook", async () => {
    const sdk = createFakeSdkClient({
      respond: (_msg) => [resultSuccess("done")],
    });
    const harness = createCasdkHarness({
      store: createMemorySessionStore(),
      sdk,
      toolServer: createFakeToolServer(),
      toolContext: fakeToolContextFactory(),
      model: "claude-test",
      now: tickingNow(),
      newUuid: seqUuid("u"),
    });
    const { input } = runInput();
    const result = await harness.run(input);

    // The run completed (a gating hook would have had to be consulted first).
    expect(result.events.at(-1)!.type).toBe("run_finished");

    // Only the PostCompact observer hook is wired — no gating keys.
    const hooks = (sdk.calls[0]!.options.hooks ?? {}) as Record<string, unknown>;
    expect(Object.keys(hooks)).toEqual(["PostCompact"]);
    for (const gate of ["PreToolUse", "PostToolUse", "PermissionRequest", "CanUseTool"]) {
      expect(hooks[gate]).toBeUndefined();
    }
    // The built-in tool surface is authoritatively disabled + permissions bypassed.
    expect(sdk.calls[0]!.options.tools).toEqual([]);
    expect(sdk.calls[0]!.options.permissionMode).toBe("bypassPermissions");
  });

  it("extracts a finalized tool_call/tool_result + token deltas from the stream WITHOUT any hook gating", async () => {
    // A single assistant turn: a text delta (partial-message), a tool_use, then
    // its tool_result on the next user record — all captured from the stream.
    const sdk = createFakeSdkClient({
      respond: (_msg) => {
        const partial: SdkStreamRecord = {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "look" } },
          parent_tool_use_id: null,
        } as SdkStreamRecord;
        const assistant: SdkStreamRecord = {
          type: "assistant",
          message: {
            id: "api-1",
            content: [
              { type: "text", text: "looking" },
              { type: "tool_use", id: "toolu_1", name: "mcp__teaspill__echo", input: { text: "x" } },
            ],
            usage: { input_tokens: 5, output_tokens: 3 },
          },
          parent_tool_use_id: null,
        } as SdkStreamRecord;
        const toolResult: SdkStreamRecord = {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }],
          },
        } as SdkStreamRecord;
        return [partial, assistant, toolResult, resultSuccess("ok")];
      },
    });
    const harness = createCasdkHarness({
      store: createMemorySessionStore(),
      sdk,
      toolServer: createFakeToolServer(),
      toolContext: fakeToolContextFactory(),
      model: "claude-test",
      now: tickingNow(),
      newUuid: seqUuid("u"),
    });
    const { input, deltas } = runInput();
    const result = await harness.run(input);

    const types = result.events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    // A token delta was extracted live from the partial-message.
    expect(deltas.some((d) => d.kind === "text" && d.text === "look")).toBe(true);
  });
});
