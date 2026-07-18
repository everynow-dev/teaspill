/**
 * OTel observability for the coordination plane (0001:T8.2).
 *
 * Mirrors the gateway's `otel.ts` precedent (per-package setup, NOT a shared
 * package): the three instrumented planes (gateway / coordination / executor)
 * already have their own entrypoints and their own no-op-by-default telemetry;
 * a shared `@teaspill/*` observability package would force `executor` (which
 * today depends only on `@teaspill/schema`) and `coordination` to take a new
 * cross-package dependency and would not respect the existing layering. The
 * duplicated surface is tiny — a tracer/meter getter, an env-gated
 * `initTelemetry`, and the W3C trace-context envelope helpers — so each plane
 * carries its own copy, exactly as the gateway already does.
 *
 * Two things live here:
 *
 * 1. **Tracing + metrics providers**, registered ONLY when
 *    `OTEL_EXPORTER_OTLP_ENDPOINT` is set (exporter env-gated per the task).
 *    The `trace`/`metrics` globals are always safe to call — span/measurement
 *    creation is a no-op unless a provider is registered — so the default
 *    self-host stack pays nothing and every call site stays unconditional.
 *
 * 2. **Trace-context propagation across Restate sends.** A one-way Restate
 *    send (spawn / message / control at the ingress, and object→object
 *    `genericSend`s) does NOT carry the caller's HTTP headers to the handler,
 *    so W3C context cannot ride the transport the way it does over a normal
 *    HTTP hop. The convention (documented, best-effort where noted) is to
 *    thread the standard `traceparent`/`tracestate` fields ON THE MESSAGE
 *    ENVELOPE — never on a canonical event (the frozen schema, 0001:A5, is
 *    untouched; trace context is transport metadata). `injectTraceContext`
 *    writes them onto an outbound envelope; `extractTraceContext` reads them
 *    back into an OTel `Context` a handler makes active so its
 *    `agent.wake` span parents under the caller's span.
 *
 *    GUARANTEED: gateway → Restate ingress → agent handler (the gateway
 *    injects; the agent wiring extracts). BEST-EFFORT: object→object internal
 *    sends and agent → executor (the injecting side there is the harness tool
 *    client in `@teaspill/harness-native`, out of this task's edit scope — the
 *    executor extracts when the field is present, T-follow-up injects it).
 */

import {
  context as otelContext,
  metrics as otelMetrics,
  propagation as _propagation,
  ROOT_CONTEXT,
  trace,
  type Context,
  type Counter,
  type Meter,
  type ObservableResult,
  type Tracer,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { RunUsage } from "@teaspill/schema";

export const TRACER_NAME = "teaspill-coordination";
export const METER_NAME = "teaspill-coordination";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function getMeter(): Meter {
  return otelMetrics.getMeter(METER_NAME);
}

// ---------------------------------------------------------------------------
// W3C trace-context envelope convention
// ---------------------------------------------------------------------------

/** The reserved envelope fields carrying trace context (standard W3C header names). */
export const TRACE_CARRIER_KEYS = ["traceparent", "tracestate"] as const;

const PROPAGATOR = new W3CTraceContextPropagator();

/**
 * Inject the active (or given) trace context onto an outbound message
 * envelope as `traceparent`/`tracestate` fields. Mutates and returns
 * `carrier`. No-op unless a span context is active (nothing to propagate).
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
 * Read trace context back from a message envelope's `traceparent`/`tracestate`
 * fields into an OTel `Context` (rooted, so it carries only the remote span).
 * Returns `ROOT_CONTEXT` when the fields are absent — the resulting span is
 * then a normal root, never an error.
 */
export function extractTraceContext(carrier: unknown): Context {
  if (carrier === null || typeof carrier !== "object") return ROOT_CONTEXT;
  const c = carrier as Record<string, unknown>;
  return PROPAGATOR.extract(ROOT_CONTEXT, c, {
    get(source, key) {
      const v = (source as Record<string, unknown>)[key];
      return typeof v === "string" ? v : undefined;
    },
    keys(source) {
      return Object.keys(source as Record<string, unknown>);
    },
  });
}

/**
 * Split an inbound envelope into its extracted parent `Context` and a copy
 * with the reserved trace fields REMOVED, so handler logic (and any 0001:T6.1
 * strict validator) never sees the transport metadata. Non-object inputs pass
 * through untouched with a `ROOT_CONTEXT` parent.
 */
export function takeTraceContext<T>(input: T): { parent: Context; value: T } {
  if (input === null || typeof input !== "object") {
    return { parent: ROOT_CONTEXT, value: input };
  }
  const parent = extractTraceContext(input);
  const src = input as Record<string, unknown>;
  let stripped: Record<string, unknown> | null = null;
  for (const k of TRACE_CARRIER_KEYS) {
    if (k in src) {
      if (stripped === null) stripped = { ...src };
      delete stripped[k];
    }
  }
  return { parent, value: (stripped ?? src) as T };
}

// ---------------------------------------------------------------------------
// Metrics recorder seam (injectable → fake in tests; OTel-backed in prod)
// ---------------------------------------------------------------------------

/** Bounded-cardinality attributes for coordination metrics (never the entity id). */
export interface CoordinationMetricAttrs {
  entityType?: string;
  wakeSource?: string;
  outcome?: string;
}

/**
 * The coordination metrics the task requires, as a small injectable seam
 * (`agent.ts` records wakes + token spend; `reconciler.ts` records outbox
 * depth + projection lag; the alert sink records unrecoverable drift). Kept
 * behind an interface so it unit-tests against a fake and defaults to no-op.
 */
export interface CoordinationMetrics {
  /** `wakes_per_sec` — one increment per agent wake (backend derives the rate). */
  recordWake(attrs: CoordinationMetricAttrs): void;
  /** `llm_token_spend` — input+output(+cache) tokens for a finished run. */
  recordTokenSpend(usage: RunUsage, attrs: CoordinationMetricAttrs): void;
  /** `outbox_depth` — pending (staged-but-unconfirmed) outbox size for an entity. */
  recordOutboxDepth(depth: number, attrs: CoordinationMetricAttrs): void;
  /** `projection_lag` — catalog `head_seq` vs `outboxConfirmedSeq` (0001:A6), in seq units. */
  recordProjectionLag(lag: number, attrs: CoordinationMetricAttrs): void;
  /** Count of `unrecoverable_drift` alerts the reconciler raised (0001:A9 AlertSink hook). */
  recordDrift(attrs: CoordinationMetricAttrs): void;
}

export const NOOP_COORDINATION_METRICS: CoordinationMetrics = {
  recordWake() {},
  recordTokenSpend() {},
  recordOutboxDepth() {},
  recordProjectionLag() {},
  recordDrift() {},
};

function cleanAttrs(attrs: CoordinationMetricAttrs): Record<string, string> {
  const out: Record<string, string> = {};
  if (attrs.entityType !== undefined) out["entity.type"] = attrs.entityType;
  if (attrs.wakeSource !== undefined) out["wake.source"] = attrs.wakeSource;
  if (attrs.outcome !== undefined) out["run.outcome"] = attrs.outcome;
  return out;
}

// ---------------------------------------------------------------------------
// Resident gauge registry (0002:T3.3 — ObservableGauge over current values)
// ---------------------------------------------------------------------------

/** Stable, order-independent key for an attribute set. */
function attrKey(attrs: Record<string, string>): string {
  return Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`)
    .join("");
}

/**
 * The current-value backing store an `ObservableGauge` reads at collection
 * time (0002:T3.3, closing 0001:T8.2's gauge-cardinality open item).
 *
 * `outbox_depth`/`projection_lag` are FLEET gauges: the reconciler samples
 * every resident entity on a periodic tick (0001:A9). Recording those through a
 * synchronous `createGauge` had the wrong lifecycle — the OTel SDK keeps
 * re-exporting the last sample every interval, forever, even for entity types
 * that have gone quiet, and there is no way to "unset" a series. An
 * `ObservableGauge` instead PULLS from this registry only at collection time,
 * so a series reports exactly while it is resident (and `clear()`/`remove()`
 * retire it). Keys are the BOUNDED emitted attribute set (`entity.type` — the
 * high-cardinality entity id is deliberately never an attribute), so the series
 * count stays bounded regardless of fleet size.
 */
export class ResidentGaugeRegistry {
  private readonly entries = new Map<string, { value: number; attributes: Record<string, string> }>();

  /** Update (or insert) the current value for an attribute set. */
  set(attributes: Record<string, string>, value: number): void {
    this.entries.set(attrKey(attributes), { value, attributes });
  }

  /** Retire a series (lifecycle end — e.g. an entity type no longer sampled). */
  remove(attributes: Record<string, string>): void {
    this.entries.delete(attrKey(attributes));
  }

  clear(): void {
    this.entries.clear();
  }

  /** The ObservableGauge callback: observe every resident value once. */
  observe(result: ObservableResult): void {
    for (const { value, attributes } of this.entries.values()) {
      result.observe(value, attributes);
    }
  }
}

/**
 * OTel-backed metrics from a `Meter` (the global meter by default; injectable
 * for tests). `outbox_depth`/`projection_lag` are ObservableGauges over a
 * resident registry (0002:T3.3): the recorder methods UPDATE current values
 * (the reconciler is the fleet-wide sampler, 0001:A9) and a resident callback
 * OBSERVES them at collection time — correct cardinality/lifecycle, unlike the
 * per-observation synchronous gauge 0001:T8.2 shipped.
 */
export function createOtelCoordinationMetrics(meter: Meter = getMeter()): CoordinationMetrics {
  const wakes: Counter = meter.createCounter("wakes_per_sec", {
    description: "Agent wakes (invocations); backend derives per-second rate.",
    unit: "{wake}",
  });
  const tokenSpend: Counter = meter.createCounter("llm_token_spend", {
    description: "LLM tokens billed across finished runs (input + output + cache-read).",
    unit: "{token}",
  });
  const outboxRegistry = new ResidentGaugeRegistry();
  const outboxDepth = meter.createObservableGauge("outbox_depth", {
    description: "Pending (staged-but-unconfirmed) projection-outbox size, sampled per entity type.",
    unit: "{event}",
  });
  outboxDepth.addCallback((result) => outboxRegistry.observe(result));

  const lagRegistry = new ResidentGaugeRegistry();
  const projectionLag = meter.createObservableGauge("projection_lag", {
    description: "Catalog head_seq vs outboxConfirmedSeq, sampled per entity type.",
    unit: "{seq}",
  });
  projectionLag.addCallback((result) => lagRegistry.observe(result));

  const drift: Counter = meter.createCounter("projection_unrecoverable_drift", {
    description: "Unrecoverable projection-drift alerts raised by the reconciler.",
    unit: "{alert}",
  });
  return {
    recordWake(attrs) {
      wakes.add(1, cleanAttrs(attrs));
    },
    recordTokenSpend(usage, attrs) {
      const total =
        usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0);
      if (total > 0) tokenSpend.add(total, cleanAttrs(attrs));
    },
    recordOutboxDepth(depth, attrs) {
      outboxRegistry.set(cleanAttrs(attrs), depth);
    },
    recordProjectionLag(lag, attrs) {
      lagRegistry.set(cleanAttrs(attrs), lag);
    },
    recordDrift(attrs) {
      drift.add(1, cleanAttrs(attrs));
    },
  };
}

// ---------------------------------------------------------------------------
// Provider registration (env-gated — no exporter, no cost)
// ---------------------------------------------------------------------------

/**
 * Register a NodeTracerProvider + MeterProvider with OTLP/HTTP exporters when
 * `otlpEndpoint` is set; a no-op (returns an empty shutdown) otherwise. SDK
 * imports are lazy so the common no-exporter path never loads them.
 */
export async function initTelemetry(opts: {
  otlpEndpoint: string | undefined;
  serviceName?: string;
}): Promise<() => Promise<void>> {
  if (!opts.otlpEndpoint) {
    return async () => {};
  }
  const serviceName = opts.serviceName ?? "teaspill-coordination";
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
