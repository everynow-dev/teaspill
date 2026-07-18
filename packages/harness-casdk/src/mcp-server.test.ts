/**
 * 0001:T7.2 — the REAL in-process MCP tool server, exercised offline against a FAKE
 * SDK-MCP api (no `@anthropic-ai/claude-agent-sdk`, no subprocess). Proves the
 * Effects-layer contract: every tool is exposed as `mcp__teaspill__<name>` and
 * a side-effecting call routes through the shared `ToolContext` carrying the
 * exactly-once idempotency key `(entityUrl, runId, toolUseId)` (0001:T3.1).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AnyToolDefinition, ToolContext } from "@teaspill/harness-native";
import { platformTools, toolIdempotencyKey, workspaceTools } from "@teaspill/harness-native";
import {
  createMcpToolServer,
  resolveToolUseId,
  toRawShape,
  type McpToolHandler,
  type SdkMcpApi,
  type SdkMcpToolLike,
} from "./mcp-server.js";
import { toMcpName } from "./translation.js";
import type { CasdkToolServerBinding } from "./tool-seam.js";
import { fakeToolContextFactory } from "./testing.js";

// ---------------------------------------------------------------------------
// A fake SDK-MCP api: records what `tool()`/`createSdkMcpServer()` are given.
// ---------------------------------------------------------------------------

function fakeSdkMcpApi(): { api: SdkMcpApi; registered: SdkMcpToolLike[]; closed: () => boolean } {
  const registered: SdkMcpToolLike[] = [];
  let closed = false;
  const api: SdkMcpApi = {
    tool(name, description, inputSchema, handler) {
      const def: SdkMcpToolLike = { name, description, inputSchema, handler };
      registered.push(def);
      return def;
    },
    createSdkMcpServer(opts) {
      return {
        type: "sdk",
        name: opts.name,
        instance: {
          close() {
            closed = true;
          },
        },
      };
    },
  };
  return { api, registered, closed: () => closed };
}

/** A side-effecting custom tool that echoes its input and returns structured detail. */
function echoTool(): AnyToolDefinition {
  return {
    name: "echo",
    description: "Echo the input back.",
    schema: z.object({ text: z.string() }),
    async execute(input: { text: string }, ctx: ToolContext) {
      return {
        content: [{ type: "text" as const, text: `echo:${input.text}` }],
        detail: { echoed: input.text, key: ctx.idempotencyKey },
      };
    },
  } as unknown as AnyToolDefinition;
}

const ENTITY = "/t/default/a/researcher/r1";
const RUN = "run-x";

function binding(tools: readonly AnyToolDefinition[], toolContext = fakeToolContextFactory()) {
  const b: CasdkToolServerBinding = {
    entityId: ENTITY,
    runId: RUN,
    signal: new AbortController().signal,
    tools,
    toolContext,
  };
  return { binding: b, toolContext };
}

// ---------------------------------------------------------------------------

describe("createMcpToolServer — tool exposure", () => {
  it("exposes every platform + workspace tool as mcp__teaspill__<name> with a matching allowedTools", () => {
    const tools = [...platformTools(), ...workspaceTools()];
    const { api, registered } = fakeSdkMcpApi();
    const { binding: b } = binding(tools);

    const server = createMcpToolServer(api)(b);

    const expected = tools.map((t) => toMcpName(t.name));
    expect(registered.map((r) => r.name).sort()).toEqual([...expected].sort());
    expect(server.allowedTools.sort()).toEqual([...expected].sort());
    // The mcpServers record is keyed `teaspill` (matches the qualified names).
    expect(Object.keys(server.mcpServers)).toEqual(["teaspill"]);
    // Each registered tool carries a raw Zod shape (not JSON Schema).
    for (const r of registered) expect(typeof r.inputSchema).toBe("object");
  });

  it("close() tears the SDK server instance down (best-effort)", async () => {
    const { api, closed } = fakeSdkMcpApi();
    const { binding: b } = binding([echoTool()]);
    const server = createMcpToolServer(api)(b);
    await server.close?.();
    expect(closed()).toBe(true);
  });
});

describe("createMcpToolServer — side-effect routing (0001:T3.1 exactly-once key)", () => {
  it("routes a call through the shared ToolContext with (entityUrl, runId, toolUseId) and back-fills detail", async () => {
    const tools = [echoTool()];
    const { api, registered } = fakeSdkMcpApi();
    const { binding: b, toolContext } = binding(tools);
    const server = createMcpToolServer(api)(b);

    const handler: McpToolHandler = registered.find((r) => r.name === toMcpName("echo"))!.handler;
    // The MCP handler only ever sees `extra` — here the MCP JSON-RPC requestId.
    const result = await handler({ text: "hi" }, { requestId: "toolu_42" });

    // Executed through the shared factory with the exactly-once key.
    expect(toolContext.calls).toEqual([
      { toolUseId: "toolu_42", idempotencyKey: toolIdempotencyKey(ENTITY, RUN, "toolu_42") },
    ]);
    // Result content maps to MCP text blocks; not an error.
    expect(result).toMatchObject({ content: [{ type: "text", text: "echo:hi" }], isError: false });
    // Structured detail rides `structuredContent` AND the §4.6 detail recorder.
    expect(result.structuredContent).toMatchObject({ echoed: "hi" });
    expect(server.detail.take("toolu_42")).toMatchObject({ echoed: "hi" });
  });

  it("a schema-invalid call is a model-visible error, never a thrown crash", async () => {
    const { api, registered } = fakeSdkMcpApi();
    const { binding: b, toolContext } = binding([echoTool()]);
    createMcpToolServer(api)(b);
    const handler = registered[0]!.handler;

    const result = await handler({ text: 123 }, { requestId: "r1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    // A rejected-at-schema call never reaches the ToolContext factory.
    expect(toolContext.calls).toEqual([]);
  });

  it("a throwing tool degrades to isError, never crashes the server", async () => {
    const boom = {
      name: "boom",
      description: "throws",
      schema: z.object({}),
      async execute() {
        throw new Error("kaboom");
      },
    } as unknown as AnyToolDefinition;
    const { api, registered } = fakeSdkMcpApi();
    const { binding: b } = binding([boom]);
    createMcpToolServer(api)(b);
    const result = await registered[0]!.handler({}, { requestId: "r1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/kaboom/) });
  });
});

describe("resolveToolUseId / toRawShape", () => {
  it("prefers a real id field, then requestId, then a minted uuid", () => {
    expect(resolveToolUseId({ toolUseId: "toolu_real" })).toBe("toolu_real");
    expect(resolveToolUseId({ _meta: { "anthropic/toolUseId": "toolu_meta" } })).toBe("toolu_meta");
    expect(resolveToolUseId({ requestId: "req-abc" })).toBe("req-abc");
    expect(resolveToolUseId({ requestId: 7 })).toBe("req-7");
    expect(resolveToolUseId({})).toMatch(/^mcp-/);
  });

  it("extracts the raw shape of a Zod object; degrades non-objects to an empty shape", () => {
    const shape = toRawShape(z.object({ a: z.string(), b: z.number() }));
    expect(Object.keys(shape).sort()).toEqual(["a", "b"]);
    expect(toRawShape(z.string())).toEqual({});
  });
});
