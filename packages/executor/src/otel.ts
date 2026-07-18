/**
 * OTel observability for the executor plane (0001:T8.2).
 *
 * Per-package setup mirroring the gateway/coordination `otel.ts` precedent
 * (see the coordination copy's header for why the three planes each carry
 * their own thin module rather than a shared package — layering: `executor`
 * otherwise depends only on `@teaspill/schema`). Providers register ONLY when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set; every call site is a no-op otherwise.
 *
 * Trace propagation here is EXTRACT-only: the workspace `exec` handler reads a
 * `traceparent` field off the exec envelope (when the caller supplied one) so
 * its `workspace.exec` span parents under the agent/harness that invoked it.
 * The injecting side is the harness tool client in `@teaspill/harness-native`
 * (out of this task's edit scope), so gateway → … → executor linkage is
 * best-effort until that injects — the executor is ready for it today.
 */

import {
  metrics as otelMetrics,
  ROOT_CONTEXT,
  trace,
  type Context,
  type Gauge,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

export const TRACER_NAME = "teaspill-executor";
export const METER_NAME = "teaspill-executor";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function getMeter(): Meter {
  return otelMetrics.getMeter(METER_NAME);
}

// ---------------------------------------------------------------------------
// Trace-context extraction (envelope convention — see coordination/otel.ts)
// ---------------------------------------------------------------------------

const PROPAGATOR = new W3CTraceContextPropagator();

/** Read trace context off an inbound envelope's `traceparent`/`tracestate` fields. */
export function extractTraceContext(carrier: unknown): Context {
  if (carrier === null || typeof carrier !== "object") return ROOT_CONTEXT;
  return PROPAGATOR.extract(ROOT_CONTEXT, carrier as Record<string, unknown>, {
    get(source, key) {
      const v = (source as Record<string, unknown>)[key];
      return typeof v === "string" ? v : undefined;
    },
    keys(source) {
      return Object.keys(source as Record<string, unknown>);
    },
  });
}

// ---------------------------------------------------------------------------
// Metrics recorder seam (workspace pool gauge)
// ---------------------------------------------------------------------------

/** Bounded-cardinality attributes for executor metrics (never the workspace key). */
export interface ExecutorMetricAttrs {
  adapter?: string;
}

/**
 * Executor metrics — just the `workspace_pool` gauge for v1 (active
 * workspaces + running execs on this host). Injectable seam so it unit-tests
 * against a fake meter and defaults to no-op.
 */
export interface ExecutorMetrics {
  /** `workspace_pool` — active workspaces and in-flight execs on this host. */
  recordWorkspacePool(sample: { activeWorkspaces: number; runningExecs: number }): void;
}

export const NOOP_EXECUTOR_METRICS: ExecutorMetrics = {
  recordWorkspacePool() {},
};

export function createOtelExecutorMetrics(meter: Meter = getMeter()): ExecutorMetrics {
  const workspaces: Gauge = meter.createGauge("workspace_pool", {
    description: "Active workspaces on this executor host.",
    unit: "{workspace}",
  });
  const execs: Gauge = meter.createGauge("workspace_pool_execs", {
    description: "In-flight (running) execs across this host's workspaces.",
    unit: "{exec}",
  });
  return {
    recordWorkspacePool(sample) {
      workspaces.record(sample.activeWorkspaces);
      execs.record(sample.runningExecs);
    },
  };
}

// ---------------------------------------------------------------------------
// Provider registration (env-gated)
// ---------------------------------------------------------------------------

/** See coordination/otel.ts `initTelemetry`. No-op unless `otlpEndpoint` is set. */
export async function initTelemetry(opts: {
  otlpEndpoint: string | undefined;
  serviceName?: string;
}): Promise<() => Promise<void>> {
  if (!opts.otlpEndpoint) {
    return async () => {};
  }
  const serviceName = opts.serviceName ?? "teaspill-executor";
  const [
    { NodeTracerProvider, BatchSpanProcessor },
    { OTLPTraceExporter },
    { MeterProvider, PeriodicExportingMetricReader },
    { OTLPMetricExporter },
    { resourceFromAttributes },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  const resource = resourceFromAttributes({ "service.name": serviceName });
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` })),
    ],
  });
  tracerProvider.register();
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${opts.otlpEndpoint}/v1/metrics` }),
      }),
    ],
  });
  otelMetrics.setGlobalMeterProvider(meterProvider);
  return async () => {
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  };
}
