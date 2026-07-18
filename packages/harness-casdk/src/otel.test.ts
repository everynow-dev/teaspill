/**
 * 0002:T3.3 observability — CASDK harness.
 *
 * Capture opens a per-tool-call `tool.call` span (child of the active
 * `harness.run` span the agent handler opens) when the SDK stream finalizes a
 * tool_use, closing it when the matching tool_result arrives (tagged outcome),
 * and closes any dangling span at `finish()`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Span } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { CaptureState, type CaptureOptions } from "./capture.js";
import { getTracer } from "./otel.js";
import { getTranslation } from "./translation.js";
import { createDetailRecorder } from "./tool-seam.js";
import { collectingDelta, tickingNow } from "./testing.js";
import type { SdkStreamRecord } from "./sdk-client.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => provider.register());
afterEach(() => exporter.reset());
afterAll(async () => provider.shutdown());

function makeCapture(overrides: Partial<CaptureOptions> = {}): CaptureState {
  const { emit } = collectingDelta();
  return new CaptureState({
    entityId: "/t/default/a/x/y",
    runId: "run-1",
    table: getTranslation(),
    emitDelta: emit,
    detail: createDetailRecorder(),
    now: tickingNow(),
    ...overrides,
  });
}

const feed = (state: CaptureState, records: SdkStreamRecord[]): void => {
  for (const r of records) state.onRecord(r);
};

describe("tool.call span (CASDK harness)", () => {
  it("opens a tool.call span child of harness.run, closed on tool_result with outcome", () => {
    const state = makeCapture();
    let harnessSpanId = "";
    getTracer().startActiveSpan("harness.run", (hspan: Span) => {
      harnessSpanId = hspan.spanContext().spanId;
      feed(state, [
        {
          type: "assistant",
          message: {
            id: "api-1",
            content: [{ type: "tool_use", id: "toolu_1", name: "mcp__teaspill__bash", input: { cmd: "ls" } }],
            usage: { input_tokens: 5 },
          },
          parent_tool_use_id: null,
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] }],
          },
        },
        { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01 },
      ]);
      state.finish();
      hspan.end();
    });

    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === "tool.call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes).toMatchObject({
      "teaspill.tool.name": "bash",
      "teaspill.tool.use_id": "toolu_1",
      "teaspill.tool.outcome": "success",
    });
    expect(toolSpan!.parentSpanContext?.spanId).toBe(harnessSpanId);
  });

  it("tags outcome=error when the tool_result is_error", () => {
    const state = makeCapture();
    getTracer().startActiveSpan("harness.run", (hspan: Span) => {
      feed(state, [
        {
          type: "assistant",
          message: { id: "api-1", content: [{ type: "tool_use", id: "toolu_2", name: "mcp__teaspill__bash", input: {} }], usage: {} },
          parent_tool_use_id: null,
        },
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true }] },
        },
      ]);
      state.finish();
      hspan.end();
    });
    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === "tool.call");
    expect(toolSpan!.attributes).toMatchObject({ "teaspill.tool.outcome": "error" });
  });

  it("closes a dangling tool span (no tool_result) at finish() with outcome=incomplete", () => {
    const state = makeCapture();
    getTracer().startActiveSpan("harness.run", (hspan: Span) => {
      feed(state, [
        {
          type: "assistant",
          message: { id: "api-1", content: [{ type: "tool_use", id: "toolu_3", name: "mcp__teaspill__bash", input: {} }], usage: {} },
          parent_tool_use_id: null,
        },
        // aborted mid-tool: no tool_result, straight to result.
        { type: "result", subtype: "error_during_execution" },
      ]);
      state.finish();
      hspan.end();
    });
    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === "tool.call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes).toMatchObject({ "teaspill.tool.outcome": "incomplete" });
  });
});
