/**
 * T8.2 — gateway trace-context injection onto the Restate ingress envelope.
 *
 * A Restate one-way send drops HTTP headers, so the gateway threads W3C
 * context as `traceparent`/`tracestate` fields ON THE ENVELOPE. These assert
 * the injection and its round-trip back out (the coordination agent extracts
 * the same fields). No tracer provider needed — a wrapped span context stands
 * in for the request span.
 */

import { describe, expect, it } from "vitest";
import { ROOT_CONTEXT, trace, TraceFlags, type SpanContext } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { injectTraceContext } from "./otel.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function sampledSpan() {
  const spanContext: SpanContext = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  };
  return trace.wrapSpanContext(spanContext);
}

describe("gateway injectTraceContext", () => {
  it("writes a W3C traceparent onto the ingress envelope from the request span", () => {
    const carrier = injectTraceContext({ verb: "interrupt" } as Record<string, unknown>, sampledSpan());
    expect(carrier["traceparent"]).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    // The payload's own fields are preserved.
    expect(carrier["verb"]).toBe("interrupt");
  });

  it("round-trips back to the same trace/span id via the W3C propagator (the agent's extract side)", () => {
    const carrier = injectTraceContext({} as Record<string, unknown>, sampledSpan());
    const extracted = new W3CTraceContextPropagator().extract(ROOT_CONTEXT, carrier, {
      get: (c, k) => {
        const v = (c as Record<string, unknown>)[k];
        return typeof v === "string" ? v : undefined;
      },
      keys: (c) => Object.keys(c as Record<string, unknown>),
    });
    const remote = trace.getSpanContext(extracted);
    expect(remote?.traceId).toBe(TRACE_ID);
    expect(remote?.spanId).toBe(SPAN_ID);
  });

  it("injects nothing when there is no recording span (no active context)", () => {
    const carrier = injectTraceContext({ content: [] } as Record<string, unknown>);
    expect(carrier["traceparent"]).toBeUndefined();
  });
});
