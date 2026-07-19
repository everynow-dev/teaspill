/**
 * 0002:T3.3 observability — native harness.
 *
 * 1. The pi step loop opens a per-tool-call `tool.call` span as a CHILD of the
 *    active `harness.run` span (the agent handler opens that outer span), tagged
 *    tool name / use id / outcome.
 * 2. The `bash` tool injects the ACTIVE trace context onto the exec-options
 *    ENVELOPE (never a canonical event), and it round-trips via
 *    `extractTraceContext` (the same W3C convention the executor extracts).
 *    No active span ⇒ the envelope carries no trace fields (no-op default).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { trace, type Span } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type {
  ExecOptions,
  ExecResult,
  ToolContext,
  ToolDefinition,
  WorkspaceClient,
} from "./interface.js";
import { extractTraceContext, getTracer, TRACE_CARRIER_KEYS } from "./otel.js";
import { bashTool } from "./workspace-tools.js";
import { createPiHarness, type HarnessCtx, type ToolContextBinding } from "./pi-harness.js";
import type { PiStepClient, PiStepRequest, PiStepTurn, PiTurnUsage } from "./pi-client.js";

// ---------------------------------------------------------------------------
// In-memory tracer
// ---------------------------------------------------------------------------

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => provider.register());
afterEach(() => exporter.reset());
afterAll(async () => provider.shutdown());

const USAGE: PiTurnUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

// ---------------------------------------------------------------------------
// 1. per-tool-call span nests under harness.run
// ---------------------------------------------------------------------------

class FakeCtx implements HarnessCtx {
  async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
    return action();
  }
}

/** A step client: turn 0 calls `echo`, turn 1 stops. */
class ToolThenStopClient implements PiStepClient {
  readonly provider = "fake";
  readonly model = "fake-model";
  readonly buffered = true;
  readonly contextWindow = undefined;
  private calls = 0;
  async step(_req: PiStepRequest): Promise<PiStepTurn> {
    const i = this.calls++;
    if (i === 0) {
      return {
        content: [{ type: "toolCall", toolUseId: "tu-1", name: "echo", input: { text: "hi" } }],
        usage: USAGE,
        stopReason: "toolUse",
      };
    }
    return { content: [{ type: "text", text: "done" }], usage: USAGE, stopReason: "stop" };
  }
}

function echoTool(): ToolDefinition<{ text: string }> {
  return {
    name: "echo",
    description: "Echo the text back.",
    schema: z.object({ text: z.string() }).strict(),
    async execute(input) {
      return { content: [{ type: "text", text: `echo:${input.text}` }] };
    },
  };
}

describe("tool.call span (native harness)", () => {
  it("opens a tool.call span as a child of harness.run, tagged name/use_id/outcome", async () => {
    const harness = createPiHarness({
      ctx: new FakeCtx(),
      client: new ToolThenStopClient(),
      toolContext: (b: ToolContextBinding): ToolContext => ({
        entityUrl: b.entityUrl,
        runId: b.runId,
        toolUseId: b.toolUseId,
        idempotencyKey: b.idempotencyKey,
        signal: b.signal,
        platform: {
          spawn: async () => ({ entityId: "x" }),
          send: async () => undefined,
          listChildren: async () => [],
        },
      }),
      emitRunBoundaries: false,
    });

    let harnessSpanId = "";
    await getTracer().startActiveSpan("harness.run", async (hspan: Span) => {
      harnessSpanId = hspan.spanContext().spanId;
      await harness.run({
        entityId: "/t/default/a/worker/i1",
        runId: "run-1",
        canonicalContext: [],
        wakeMessage: null,
        tools: [echoTool()] as never,
        steerSource: { drain: async () => [] },
        signal: new AbortController().signal,
        emitDelta: () => {},
      });
      hspan.end();
    });

    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === "tool.call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes).toMatchObject({
      "teaspill.tool.name": "echo",
      "teaspill.tool.use_id": "tu-1",
      "teaspill.tool.outcome": "success",
    });
    // Nested under harness.run.
    expect(toolSpan!.parentSpanContext?.spanId).toBe(harnessSpanId);
  });
});

// ---------------------------------------------------------------------------
// 2. bash tool injects trace context onto the exec envelope
// ---------------------------------------------------------------------------

function captureWorkspace(sink: ExecOptions[]): WorkspaceClient {
  const nope = (): never => {
    throw new Error("unused");
  };
  return {
    workspaceRef: "default/ws",
    async exec(_cmd: string, opts?: ExecOptions): Promise<ExecResult> {
      sink.push(opts ?? {});
      return { exitCode: 0, tail: "" };
    },
    readFile: nope,
    writeFile: nope,
    ls: nope,
    mkdir: nope,
    rm: nope,
    stat: nope,
  };
}

function toolCtx(ws: WorkspaceClient): ToolContext {
  return {
    entityUrl: "/t/default/a/worker/i1",
    runId: "run-1",
    toolUseId: "tu-1",
    idempotencyKey: "k",
    signal: new AbortController().signal,
    platform: {
      spawn: async () => ({ entityId: "x" }),
      send: async () => undefined,
      listChildren: async () => [],
    },
    workspace: ws,
  };
}

describe("bash trace-context injection (native harness)", () => {
  it("injects the active span onto the exec envelope, round-tripping via extractTraceContext", async () => {
    const captured: ExecOptions[] = [];
    const tool = bashTool();

    let traceId = "";
    let spanId = "";
    await getTracer().startActiveSpan("tool.call", async (span: Span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      await tool.execute({ command: "echo hi" } as never, toolCtx(captureWorkspace(captured)));
      span.end();
    });

    const opts = captured[0]!;
    expect(typeof opts.traceparent).toBe("string");
    const parent = extractTraceContext(opts);
    const sc = trace.getSpanContext(parent!);
    expect(sc?.traceId).toBe(traceId);
    expect(sc?.spanId).toBe(spanId); // the exec parents under the tool.call span
  });

  it("writes no trace fields when there is no active span (no-op default)", async () => {
    const captured: ExecOptions[] = [];
    const tool = bashTool();
    // No active span context ⇒ nothing to propagate.
    await tool.execute({ command: "echo hi" } as never, toolCtx(captureWorkspace(captured)));
    const opts = captured[0]!;
    for (const k of TRACE_CARRIER_KEYS) {
      expect(opts[k as keyof ExecOptions]).toBeUndefined();
    }
    expect(extractTraceContext(opts)).toBeUndefined();
  });
});
