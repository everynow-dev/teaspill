/**
 * Tool-invocation seam (T7.1, D5 layer 1 — Effects). T7.2 plugs in here.
 *
 * The harness itself never executes tools — the CASDK subprocess calls them
 * through an in-process MCP server. This module defines the seam the harness
 * consumes and T7.2 implements:
 *
 * - `CasdkToolServerFactory` — per RUN, given the run binding (entityId,
 *   runId, signal, tools, toolContext), produce the `mcpServers` +
 *   `allowedTools` query options plus a `detail` source. T7.2's real
 *   implementation builds the SDK's `createSdkMcpServer`/`tool()` server
 *   whose handlers execute each `ToolDefinition` through a `ToolContext`
 *   built by `toolContext` — which routes every side effect through Restate
 *   ingress with the exactly-once idempotency key
 *   `(entityUrl, runId, toolUseId)` (T3.1 invariant 1; the frozen contract).
 *
 * - `ToolResultDetailSource` — the §4.6 back-fill channel: the SDK's MCP
 *   boundary only echoes `content` blocks, so structured `tool_result.detail`
 *   is recovered from the tool layer's OWN return value. Capture consults
 *   this source, keyed by toolUseId, when it maps a `tool_result` block.
 *   CAVEAT for T7.2 (digest §2 Effects): the MCP handler does NOT reliably
 *   receive the real `toolUseId` — correlate on the STREAM side (tool_use →
 *   next execution), not from MCP `extra.requestId`.
 *
 * The naming contract (`mcp__teaspill__<name>`) lives in translation.ts
 * (`toMcpName`/`fromMcpName`) — one source of truth for both directions.
 */

import type { JsonValue } from "@teaspill/schema";
import type { AnyToolDefinition, ToolContextFactory } from "@teaspill/harness-native";
import { toMcpName } from "./translation.js";

/** Capture-side lookup for structured tool-result detail (mapping §4.6). */
export interface ToolResultDetailSource {
  /** Detail recorded for a tool call, or undefined. Consumed at most once per id. */
  take(toolUseId: string): JsonValue | undefined;
}

export interface CasdkToolServerBinding {
  entityId: string;
  runId: string;
  /** Aborts with the run — long tools must observe it. */
  signal: AbortSignal;
  tools: readonly AnyToolDefinition[];
  /**
   * Builds the per-call `ToolContext` bound to the idempotency key
   * (`toolIdempotencyKey(entityId, runId, toolUseId)`). Injected by the
   * agents-sdk wiring — same factory shape the pi harness uses.
   */
  toolContext: ToolContextFactory;
}

export interface CasdkToolServer {
  /** Passed through to the query's `mcpServers` option. */
  mcpServers: Record<string, unknown>;
  /** Auto-approve list (`mcp__teaspill__<name>` per tool). NOT the disable switch. */
  allowedTools: string[];
  /** §4.6 detail back-fill consulted by capture. */
  detail: ToolResultDetailSource;
  /** Optional teardown after the run settles. */
  close?(): Promise<void>;
}

export type CasdkToolServerFactory = (binding: CasdkToolServerBinding) => CasdkToolServer;

/** Standard allowedTools list for a tool set. */
export function allowedToolsFor(tools: readonly AnyToolDefinition[]): string[] {
  return tools.map((t) => toMcpName(t.name));
}

/** A detail source over a plain map (used by fakes and by T7.2's recorder). */
export function createDetailRecorder(): ToolResultDetailSource & {
  record(toolUseId: string, detail: JsonValue): void;
} {
  const map = new Map<string, JsonValue>();
  return {
    record(toolUseId, detail) {
      map.set(toolUseId, detail);
    },
    take(toolUseId) {
      const d = map.get(toolUseId);
      map.delete(toolUseId);
      return d;
    },
  };
}

/** No tools at all (control-only agents; unit tests). */
export function noToolServer(): CasdkToolServerFactory {
  return () => ({
    mcpServers: {},
    allowedTools: [],
    detail: { take: () => undefined },
  });
}

/**
 * Offline FAKE tool server: no MCP, no SDK. It exposes the same seam surface
 * and an `execute` helper the fake SDK client script uses to run a tool the
 * way T7.2's real MCP handler will (schema-parse → ToolContext with the bound
 * idempotency key → record detail). This keeps the Effects-layer contract —
 * exactly-once keying and detail back-fill — testable without a subprocess.
 */
export function createFakeToolServer(): CasdkToolServerFactory & {
  lastInstance: FakeToolServerInstance | undefined;
} {
  const factory = Object.assign(
    (binding: CasdkToolServerBinding): CasdkToolServer => {
      const instance = new FakeToolServerInstance(binding);
      factory.lastInstance = instance;
      return instance;
    },
    { lastInstance: undefined as FakeToolServerInstance | undefined },
  );
  return factory;
}

export class FakeToolServerInstance implements CasdkToolServer {
  readonly mcpServers: Record<string, unknown>;
  readonly allowedTools: string[];
  readonly detailRecorder = createDetailRecorder();
  readonly executed: Array<{ toolUseId: string; name: string; idempotencyKey: string }> = [];
  private readonly binding: CasdkToolServerBinding;

  constructor(binding: CasdkToolServerBinding) {
    this.binding = binding;
    this.mcpServers = { teaspill: { fake: true } };
    this.allowedTools = allowedToolsFor(binding.tools);
  }

  get detail(): ToolResultDetailSource {
    return this.detailRecorder;
  }

  /** Execute a tool as the real MCP handler would (test driver). */
  async execute(toolUseId: string, name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
    const tool = this.binding.tools.find((t) => t.name === name);
    if (!tool) return { text: `Unknown tool "${name}"`, isError: true };
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) return { text: `Invalid input for "${name}": ${parsed.error.message}`, isError: true };
    const { toolIdempotencyKey } = await import("@teaspill/harness-native");
    const idempotencyKey = toolIdempotencyKey(this.binding.entityId, this.binding.runId, toolUseId);
    const ctx = this.binding.toolContext({
      entityUrl: this.binding.entityId,
      runId: this.binding.runId,
      toolUseId,
      idempotencyKey,
      signal: this.binding.signal,
    });
    this.executed.push({ toolUseId, name, idempotencyKey });
    try {
      const result = await tool.execute(parsed.data as never, ctx);
      if (result.detail !== undefined) this.detailRecorder.record(toolUseId, result.detail);
      const text = result.content
        .filter((b): b is Extract<(typeof result.content)[number], { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { text, isError: result.isError ?? false };
    } catch (err) {
      return { text: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}
