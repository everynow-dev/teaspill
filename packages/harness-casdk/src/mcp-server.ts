/**
 * In-process MCP tool server (T7.2, D5 layer 1 — Effects). The REAL
 * `CasdkToolServerFactory` that replaces T7.1's fake (`tool-seam.ts`).
 *
 * The CASDK subprocess never runs teaspill's tools itself — it calls them
 * through an in-process MCP server built with the SDK's SDK-MCP mechanism
 * (`createSdkMcpServer` + `tool`, confirmed against
 * `@anthropic-ai/claude-agent-sdk@0.3.211`'s `sdk.d.ts`). Each tool is exposed
 * as `mcp__teaspill__<name>` (naming owned by translation.ts) and its handler
 * executes the T3.3/T4.3 `ToolDefinition` through a per-call `ToolContext`
 * that routes every side effect through Restate ingress with the exactly-once
 * idempotency key `(entityUrl, runId, toolUseId)` (T3.1 invariant 1).
 *
 * ## SDK-api injection (offline discipline)
 *
 * The heavy `@anthropic-ai/claude-agent-sdk` module (which spawns the CLI on
 * `query()`) is NEVER imported at module load — mirroring `sdk-client.ts`. The
 * SDK's `tool`/`createSdkMcpServer` primitives are consumed through the
 * injected `SdkMcpApi` seam: real runs pass `await loadSdkMcpApi()` (a lazy
 * dynamic import), offline tests pass a fake. `createMcpToolServer(api)` is a
 * pure function of that seam.
 *
 * ## The toolUseId gap (digest §2 Effects / §3)
 *
 * The SDK-MCP handler does NOT reliably receive the real Anthropic `tool_use`
 * block id — verified against 0.3.211: `extra` carries only the MCP JSON-RPC
 * `requestId` (the SDK does not forward the block id via `_meta`). We therefore
 * derive a per-call id from `extra` (preferring any real-id-bearing field the
 * SDK might add later, then `requestId`, then a minted uuid) and use it for
 * BOTH the idempotency key and the `detail` back-fill key. Capture keys its
 * detail back-fill on the real block id, so when the two differ capture falls
 * back to the stream's `tool_use_result` (§4.6). This is correct for
 * exactly-once effects: under a whole-run retry the durable session / canonical
 * rebuild prevents re-execution of already-completed calls, so the key never
 * needs to match a prior attempt's — it only needs to be well-formed and unique
 * per live call. (Open item for T7.4: formalize stream-side tool_use↔execution
 * correlation if exact detail keying is ever required.)
 */

import { randomUUID } from "node:crypto";
import type { AnyToolDefinition } from "@teaspill/harness-native";
import { toolIdempotencyKey } from "@teaspill/harness-native";
import { TEASPILL_MCP_SERVER, toMcpName } from "./translation.js";
import {
  allowedToolsFor,
  createDetailRecorder,
  type CasdkToolServer,
  type CasdkToolServerBinding,
  type CasdkToolServerFactory,
  type ToolResultDetailSource,
} from "./tool-seam.js";

// ===========================================================================
// The SDK-MCP api seam (structural subset of the pinned SDK)
// ===========================================================================

/** One MCP text/image content block a handler returns (subset of `CallToolResult.content`). */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Structural subset of the SDK's `CallToolResult`. */
export interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export type McpToolHandler = (args: unknown, extra: unknown) => Promise<McpCallToolResult>;

/** A registered SDK-MCP tool (structural subset of `SdkMcpToolDefinition`). */
export interface SdkMcpToolLike {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: McpToolHandler;
}

/**
 * Structural subset of `@anthropic-ai/claude-agent-sdk`'s SDK-MCP surface:
 * `tool()` builds a tool definition, `createSdkMcpServer()` wraps a tool set
 * into an in-process `McpServerConfig` (the `{ type: 'sdk', name, instance }`
 * shape the query's `mcpServers` accepts).
 */
export interface SdkMcpApi {
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: McpToolHandler,
  ): SdkMcpToolLike;
  createSdkMcpServer(opts: {
    name: string;
    version?: string;
    tools?: SdkMcpToolLike[];
  }): { type: "sdk"; name: string; instance?: { close?: () => void | Promise<void> } };
}

/**
 * Lazily resolve the REAL SDK-MCP api. The `@anthropic-ai/claude-agent-sdk`
 * import happens only here, on first call — constructing a harness, compiling
 * an agent, or running offline tests never loads the SDK/CLI.
 */
export async function loadSdkMcpApi(): Promise<SdkMcpApi> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    tool: sdk.tool as unknown as SdkMcpApi["tool"],
    createSdkMcpServer: sdk.createSdkMcpServer as unknown as SdkMcpApi["createSdkMcpServer"],
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Extract a raw Zod shape for `tool()` (which requires a Zod raw shape, NOT a
 * JSON Schema — passing JSON Schema throws in 0.3.211, digest §2). Teaspill's
 * T3.3/T4.3 tools are `z.object({...}).strict()`, so `.shape` is the raw shape.
 * A non-object schema degrades to an empty shape (the model sees a no-arg tool)
 * rather than breaking the whole server build.
 */
export function toRawShape(schema: unknown): Record<string, unknown> {
  const shape = (schema as { shape?: unknown } | undefined)?.shape;
  if (shape !== null && typeof shape === "object") return shape as Record<string, unknown>;
  return {};
}

/**
 * Resolve a per-call tool-use id from the MCP handler's `extra`. Prefers any
 * real Anthropic block id the SDK might expose (future-proof), then the MCP
 * JSON-RPC `requestId` (the spike's fallback), then a minted uuid. See the
 * module header for why this is exactly-once-correct.
 */
export function resolveToolUseId(extra: unknown): string {
  const e = (extra ?? {}) as Record<string, unknown>;
  const meta = (e["_meta"] ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = [
    e["toolUseId"],
    meta["anthropic/toolUseId"],
    meta["claude/tool_use_id"],
    meta["tool_use_id"],
    e["requestId"],
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
    if (typeof c === "number") return `req-${String(c)}`;
  }
  return `mcp-${randomUUID()}`;
}

function toMcpContent(blocks: readonly { type: string; [k: string]: unknown }[]): McpContentBlock[] {
  const out: McpContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      out.push({ type: "text", text: String(b["text"] ?? "") });
    } else if (b.type === "image") {
      out.push({
        type: "image",
        data: String(b["data"] ?? ""),
        mimeType: String(b["mimeType"] ?? "application/octet-stream"),
      });
    }
  }
  return out;
}

function makeHandler(
  tool: AnyToolDefinition,
  binding: CasdkToolServerBinding,
  detail: ReturnType<typeof createDetailRecorder>,
): McpToolHandler {
  return async (args, extra) => {
    const toolUseId = resolveToolUseId(extra);
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid input for "${tool.name}": ${parsed.error.message}` }],
        isError: true,
      };
    }
    const idempotencyKey = toolIdempotencyKey(binding.entityId, binding.runId, toolUseId);
    const ctx = binding.toolContext({
      entityUrl: binding.entityId,
      runId: binding.runId,
      toolUseId,
      idempotencyKey,
      signal: binding.signal,
    });
    try {
      const result = await tool.execute(parsed.data as never, ctx);
      if (result.detail !== undefined) detail.record(toolUseId, result.detail);
      const structured =
        result.detail !== null &&
        typeof result.detail === "object" &&
        !Array.isArray(result.detail)
          ? (result.detail as Record<string, unknown>)
          : undefined;
      return {
        content: toMcpContent(result.content),
        isError: result.isError ?? false,
        ...(structured !== undefined && { structuredContent: structured }),
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  };
}

// ===========================================================================
// createMcpToolServer
// ===========================================================================

/**
 * The real in-process MCP tool server factory. Given the SDK-MCP api, returns a
 * `CasdkToolServerFactory`: per run, it builds one `mcp__teaspill__*` server
 * over the run's tools whose handlers route through the shared `toolContext`
 * with the bound idempotency key.
 */
export function createMcpToolServer(api: SdkMcpApi): CasdkToolServerFactory {
  return (binding: CasdkToolServerBinding): CasdkToolServer => {
    const detail = createDetailRecorder();
    const sdkTools = binding.tools.map((t) =>
      api.tool(toMcpName(t.name), t.description, toRawShape(t.schema), makeHandler(t, binding, detail)),
    );
    const server = api.createSdkMcpServer({
      name: TEASPILL_MCP_SERVER,
      version: "0.1.0",
      tools: sdkTools,
    });
    const instance = server.instance;
    return {
      mcpServers: { [TEASPILL_MCP_SERVER]: server },
      allowedTools: allowedToolsFor(binding.tools),
      detail: detail as ToolResultDetailSource,
      async close() {
        try {
          await instance?.close?.();
        } catch {
          // teardown is best-effort — a run has already settled.
        }
      },
    };
  };
}

/** Convenience: the real factory over the lazily-loaded SDK-MCP api. */
export async function createRealMcpToolServer(): Promise<CasdkToolServerFactory> {
  return createMcpToolServer(await loadSdkMcpApi());
}
