/**
 * OTel tracer for the CASDK harness (0002:T3.3 — closing 0001:T8.2's
 * in-harness open item).
 *
 * A thin per-package module mirroring the coordination/executor/harness-native
 * `otel.ts` precedent (each instrumented plane carries its own getter rather
 * than taking a shared observability dependency). Capture (capture.ts) uses
 * this tracer to open a per-tool-call `tool.call` span as the SDK stream yields
 * each tool_use → tool_result pair. The agent handler opens `harness.run` with
 * `startActiveSpan` (coordination/agent.ts) and the harness runs inside it, so
 * these spans nest as its CHILDREN via the active OTel context. Every call is a
 * no-op unless a tracer provider is registered — zero cost on the default
 * stack, and no trace context ever rides a canonical event (0001:A5 frozen).
 */

import { trace, type Tracer } from "@opentelemetry/api";

export const TRACER_NAME = "teaspill-harness-casdk";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}
