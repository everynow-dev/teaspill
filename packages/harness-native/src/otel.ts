/**
 * OTel observability for the native harness (0002:T3.3 — closing 0001:T8.2's
 * in-harness open items).
 *
 * Two things live here, mirroring the coordination/executor `otel.ts`
 * precedent (a thin per-package module, NOT a shared package — this package is
 * the dependency-light home of the harness interface and must not drag a
 * shared observability dep onto `@teaspill/harness-casdk`/`@teaspill/agents-sdk`,
 * which import `./interface.js` type-only):
 *
 * 1. **A tracer** so the pi step loop can open a per-tool-call `tool.call`
 *    span. The agent handler opens `harness.run` with `startActiveSpan`
 *    (coordination/agent.ts), so a span created here — inside `harness.run(...)`
 *    — nests as its CHILD automatically via the active OTel context. Every
 *    call is a no-op unless a tracer provider is registered, so the default
 *    self-host stack pays nothing.
 *
 * 2. **agent → executor trace-context injection.** The executor's
 *    `workspace.exec` handler EXTRACTS a `traceparent`/`tracestate` off the
 *    exec envelope (executor/otel.ts) so its span parents under the invoking
 *    run — but only when the caller injected one. The `bash` tool
 *    (workspace-tools.ts) is the injecting side: it writes the ACTIVE span's
 *    context onto the exec-options envelope with `injectTraceContext`. Trace
 *    context travels ON THE ENVELOPE (transport metadata) — NEVER on a
 *    canonical event or delta (the frozen schema, 0001:A5, is untouched).
 *    No active span context ⇒ nothing is written ⇒ the envelope is
 *    byte-identical to pre-0002 (no-op by default).
 */

import { context as otelContext, trace, type Context, type Tracer } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

export const TRACER_NAME = "teaspill-harness-native";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** The reserved envelope fields carrying trace context (standard W3C header names). */
export const TRACE_CARRIER_KEYS = ["traceparent", "tracestate"] as const;

const PROPAGATOR = new W3CTraceContextPropagator();

/**
 * Inject the active (or given) trace context onto an outbound envelope as
 * `traceparent`/`tracestate` fields. Mutates and returns `carrier`. No-op
 * unless a span context is active (nothing to propagate ⇒ envelope unchanged).
 */
export function injectTraceContext<T extends Record<string, unknown>>(
  carrier: T,
  ctx: Context = otelContext.active(),
): T {
  PROPAGATOR.inject(ctx, carrier, {
    set(c, k, v) {
      (c as Record<string, unknown>)[k] = v;
    },
  });
  return carrier;
}

/**
 * Read trace context back from an envelope's `traceparent`/`tracestate` fields
 * (the symmetric counterpart the executor uses; exported here so the injection
 * round-trip is testable without a cross-package dependency). Returns
 * `undefined` when the fields are absent.
 */
export function extractTraceContext(carrier: unknown): Context | undefined {
  if (carrier === null || typeof carrier !== "object") return undefined;
  const c = carrier as Record<string, unknown>;
  if (!TRACE_CARRIER_KEYS.some((k) => typeof c[k] === "string")) return undefined;
  return PROPAGATOR.extract(otelContext.active(), c, {
    get(source, key) {
      const v = (source as Record<string, unknown>)[key];
      return typeof v === "string" ? v : undefined;
    },
    keys(source) {
      return Object.keys(source as Record<string, unknown>);
    },
  });
}
