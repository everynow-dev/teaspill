/**
 * OTel tracing (T1.2 middleware requirement; feeds T8.2's gateway→Restate→
 * harness→executor trace story).
 *
 * The tracer is ALWAYS available via @opentelemetry/api — span creation is a
 * no-op unless a provider is registered. `initTelemetry` registers a real
 * NodeTracerProvider with an OTLP/HTTP exporter ONLY when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (exporter is env-gated per the task
 * text), so the default self-host stack pays nothing.
 */

import { ROOT_CONTEXT, trace, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

export const TRACER_NAME = "teaspill-gateway";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

// ---------------------------------------------------------------------------
// W3C trace-context propagation across the Restate ingress hop (T8.2)
// ---------------------------------------------------------------------------
//
// A one-way Restate ingress send does not carry the request's HTTP headers to
// the agent handler, so W3C context is threaded ON THE MESSAGE ENVELOPE as the
// standard `traceparent`/`tracestate` fields (never on a canonical event — the
// frozen schema A5 is untouched; trace context is transport metadata). The
// agent object extracts them and parents its `agent.wake` span under the
// gateway request span. See `@teaspill/coordination` otel.ts for the matching
// extract side and the guaranteed-vs-best-effort matrix.

const PROPAGATOR = new W3CTraceContextPropagator();

/**
 * Inject `span`'s (or the active) trace context onto an outbound ingress
 * envelope as `traceparent`/`tracestate`. Mutates and returns `carrier`.
 * No-op when there is no recording span context to propagate.
 */
export function injectTraceContext<T extends Record<string, unknown>>(carrier: T, span?: Span): T {
  const ctx: Context = span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT;
  PROPAGATOR.inject(ctx, carrier, {
    set(c, k, v) {
      (c as Record<string, unknown>)[k] = v;
    },
  });
  return carrier;
}

/**
 * Registers a NodeTracerProvider + OTLP exporter when `otlpEndpoint` is set.
 * Returns an async shutdown function (no-op when the exporter is disabled).
 *
 * Imports of the SDK packages are lazy so that the common no-exporter path
 * never loads them at all.
 */
export async function initTelemetry(opts: {
  otlpEndpoint: string | undefined;
  serviceName?: string;
}): Promise<() => Promise<void>> {
  if (!opts.otlpEndpoint) {
    return async () => {};
  }
  const [
    { NodeTracerProvider, BatchSpanProcessor },
    { OTLPTraceExporter },
    { resourceFromAttributes },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": opts.serviceName ?? "teaspill-gateway",
    }),
    spanProcessors: [
      // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself; passing it
      // explicitly keeps the config seam testable/overridable.
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` })),
    ],
  });
  provider.register();
  return () => provider.shutdown();
}
