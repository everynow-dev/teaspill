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

import { trace, type Tracer } from "@opentelemetry/api";

export const TRACER_NAME = "teaspill-gateway";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
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
