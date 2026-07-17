/**
 * T8.2 observability — coordination plane.
 *
 * Three concerns, all against fakes / an in-memory span exporter (no live
 * Restate, no OTLP endpoint):
 * 1. W3C trace-context propagation round-trips through the message-envelope
 *    `traceparent` convention (inject → extract preserves trace/span ids;
 *    `takeTraceContext` strips the reserved fields from handler input).
 * 2. The metrics recorder maps events → the 5 instruments on a fake meter.
 * 3. A wake creates the `agent.wake` (+ child `harness.run`) span with the
 *    right attributes and records `wakes_per_sec` + `llm_token_spend`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ROOT_CONTEXT,
  trace,
  type Context,
  type Counter,
  type Gauge,
  type Meter,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { RunUsage } from "@teaspill/schema";
import {
  InMemoryProjectionOutbox,
  createSendNotifier,
  createStubHarness,
} from "./agent-seams.js";
import {
  agentEntityUrl,
  handleMessage,
  handleSpawn,
  type AgentMessageInput,
  type AgentObjectConfig,
} from "./agent.js";
import { AGENT_KV, type AgentRuntimeCtx } from "./agent-runtime.js";
import {
  createOtelCoordinationMetrics,
  extractTraceContext,
  injectTraceContext,
  takeTraceContext,
  type CoordinationMetricAttrs,
  type CoordinationMetrics,
} from "./otel.js";

// ---------------------------------------------------------------------------
// In-memory tracer (real spans, captured — never exported off-box)
// ---------------------------------------------------------------------------

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  provider.register();
});
afterEach(() => {
  exporter.reset();
});
afterAll(async () => {
  await provider.shutdown();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Capturing metrics recorder — asserts which events fired, with what attrs. */
function capturingMetrics(): {
  metrics: CoordinationMetrics;
  calls: {
    wake: CoordinationMetricAttrs[];
    token: { usage: RunUsage; attrs: CoordinationMetricAttrs }[];
    depth: { depth: number; attrs: CoordinationMetricAttrs }[];
    lag: { lag: number; attrs: CoordinationMetricAttrs }[];
    drift: CoordinationMetricAttrs[];
  };
} {
  const calls = {
    wake: [] as CoordinationMetricAttrs[],
    token: [] as { usage: RunUsage; attrs: CoordinationMetricAttrs }[],
    depth: [] as { depth: number; attrs: CoordinationMetricAttrs }[],
    lag: [] as { lag: number; attrs: CoordinationMetricAttrs }[],
    drift: [] as CoordinationMetricAttrs[],
  };
  return {
    calls,
    metrics: {
      recordWake: (attrs) => calls.wake.push(attrs),
      recordTokenSpend: (usage, attrs) => calls.token.push({ usage, attrs }),
      recordOutboxDepth: (depth, attrs) => calls.depth.push({ depth, attrs }),
      recordProjectionLag: (lag, attrs) => calls.lag.push({ lag, attrs }),
      recordDrift: (attrs) => calls.drift.push(attrs),
    },
  };
}

/** Minimal record of a fake-meter measurement. */
interface MeterRecord {
  name: string;
  value: number;
  attrs?: Record<string, unknown> | undefined;
}

/** A fake `Meter` capturing every counter.add / gauge.record. */
function fakeMeter(): { meter: Meter; records: MeterRecord[] } {
  const records: MeterRecord[] = [];
  const counter = (name: string): Counter =>
    ({ add: (value: number, attrs?: Record<string, unknown>) => records.push({ name, value, attrs }) }) as unknown as Counter;
  const gauge = (name: string): Gauge =>
    ({ record: (value: number, attrs?: Record<string, unknown>) => records.push({ name, value, attrs }) }) as unknown as Gauge;
  const meter = {
    createCounter: (name: string) => counter(name),
    createGauge: (name: string) => gauge(name),
    createUpDownCounter: (name: string) => counter(name),
    createHistogram: (name: string) => gauge(name),
  } as unknown as Meter;
  return { meter, records };
}

/** A compact structural agent ctx (the agent.test.ts pattern, trimmed to the happy path). */
class FakeWorld {
  readonly state = new Map<string, unknown>();
  ctx(invocationId: string, otelContext?: Context): AgentRuntimeCtx {
    const state = this.state;
    const abort = new AbortController();
    return {
      key: "i-1",
      invocationId,
      runAbortSignal: abort.signal,
      ...(otelContext !== undefined && { otelContext }),
      get: async <T>(name: string): Promise<T | null> =>
        state.has(name) ? (state.get(name) as T) : null,
      set: <T>(name: string, value: T): void => {
        state.set(name, value);
      },
      clear: (name: string): void => {
        state.delete(name);
      },
      run: async <T>(_name: string, action: () => T | Promise<T>): Promise<T> => action(),
      genericSend: (): void => {},
      raceInterrupt: <T>(work: Promise<T>): Promise<T> => work,
    };
  }
}

function makeConfig(metrics?: CoordinationMetrics): {
  config: AgentObjectConfig;
  outbox: InMemoryProjectionOutbox;
} {
  const outbox = new InMemoryProjectionOutbox();
  const config: AgentObjectConfig = {
    entityType: "worker",
    harness: createStubHarness(),
    outbox,
    notifier: createSendNotifier(),
    idleArchiveDelayMs: 0, // no archive self-send in the fake
    ...(metrics !== undefined && { metrics }),
  };
  return { config, outbox };
}

// ---------------------------------------------------------------------------
// 1. Propagation
// ---------------------------------------------------------------------------

describe("trace-context envelope propagation", () => {
  it("round-trips a span's context through the traceparent envelope field", () => {
    const tracer = trace.getTracer("test");
    tracer.startActiveSpan("client-send", (span) => {
      const carrier = injectTraceContext({} as Record<string, unknown>);
      // The standard W3C field is written onto the envelope (not a canonical event).
      expect(typeof carrier["traceparent"]).toBe("string");
      expect(carrier["traceparent"]).toContain(span.spanContext().traceId);

      const extracted = extractTraceContext(carrier);
      const remote = trace.getSpanContext(extracted);
      expect(remote?.traceId).toBe(span.spanContext().traceId);
      expect(remote?.spanId).toBe(span.spanContext().spanId);
      span.end();
    });
  });

  it("extractTraceContext returns ROOT for an envelope with no trace fields", () => {
    expect(extractTraceContext({ content: [] })).toBe(ROOT_CONTEXT);
    expect(extractTraceContext(null)).toBe(ROOT_CONTEXT);
  });

  it("takeTraceContext strips the reserved fields from handler input", () => {
    const tracer = trace.getTracer("test");
    tracer.startActiveSpan("client-send", (span) => {
      const envelope = injectTraceContext({
        content: [{ type: "text", text: "hi" }],
      } as Record<string, unknown>);
      const { parent, value } = takeTraceContext(envelope);

      expect(value).not.toHaveProperty("traceparent");
      expect(value).not.toHaveProperty("tracestate");
      expect(value).toHaveProperty("content");
      expect(trace.getSpanContext(parent)?.traceId).toBe(span.spanContext().traceId);
      span.end();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Metrics recorder over a fake meter
// ---------------------------------------------------------------------------

describe("createOtelCoordinationMetrics (fake meter)", () => {
  it("maps each event to the right instrument + value", () => {
    const { meter, records } = fakeMeter();
    const m = createOtelCoordinationMetrics(meter);

    m.recordWake({ entityType: "worker", wakeSource: "message", outcome: "success" });
    m.recordTokenSpend(
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      { entityType: "worker" },
    );
    m.recordOutboxDepth(3, { entityType: "worker" });
    m.recordProjectionLag(2, { entityType: "worker" });
    m.recordDrift({ entityType: "worker" });

    expect(records).toEqual([
      { name: "wakes_per_sec", value: 1, attrs: { "entity.type": "worker", "wake.source": "message", "run.outcome": "success" } },
      { name: "llm_token_spend", value: 17, attrs: { "entity.type": "worker" } },
      { name: "outbox_depth", value: 3, attrs: { "entity.type": "worker" } },
      { name: "projection_lag", value: 2, attrs: { "entity.type": "worker" } },
      { name: "projection_unrecoverable_drift", value: 1, attrs: { "entity.type": "worker" } },
    ]);
  });

  it("does not emit a zero token-spend measurement", () => {
    const { meter, records } = fakeMeter();
    const m = createOtelCoordinationMetrics(meter);
    m.recordTokenSpend({ inputTokens: 0, outputTokens: 0 }, { entityType: "worker" });
    expect(records.filter((r) => r.name === "llm_token_spend")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Wake instrumentation (span + metrics on a driven wake)
// ---------------------------------------------------------------------------

describe("agent wake instrumentation", () => {
  it("creates agent.wake + harness.run spans and records wake + token metrics", async () => {
    const { metrics, calls } = capturingMetrics();
    const { config } = makeConfig(metrics);
    const world = new FakeWorld();
    const entityId = agentEntityUrl("default", "worker", "i-1");

    await handleSpawn(world.ctx("inv-spawn"), config, { args: { task: "go" }, parentRef: null });

    // A message wake, carrying an upstream trace context on the envelope.
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("gateway.request", async (client) => {
      const carrier = injectTraceContext({} as Record<string, unknown>);
      const { parent } = takeTraceContext(carrier);
      const msg: AgentMessageInput = { content: [{ type: "text", text: "hello" }] };
      await handleMessage(world.ctx("inv-msg", parent), config, msg);
      client.end();
    });

    // Two wakes recorded (spawn + message).
    expect(calls.wake).toHaveLength(2);
    expect(calls.wake[1]).toMatchObject({ entityType: "worker", wakeSource: "message", outcome: "success" });
    // Token spend from the stub harness (inputTokens 3 + outputTokens 5 = 8), once per wake.
    expect(calls.token).toHaveLength(2);
    expect(calls.token[1]!.usage).toEqual({ inputTokens: 3, outputTokens: 5 });

    const spans = exporter.getFinishedSpans();
    const wakeSpans = spans.filter((s) => s.name === "agent.wake");
    const harnessSpans = spans.filter((s) => s.name === "harness.run");
    expect(wakeSpans.length).toBe(2);
    expect(harnessSpans.length).toBe(2);

    // The message wake's span carries the required attributes.
    const msgWake = wakeSpans.find((s) => s.attributes["wake.source"] === "message");
    expect(msgWake).toBeDefined();
    expect(msgWake!.attributes).toMatchObject({
      "teaspill.entity.id": entityId,
      "teaspill.entity.type": "worker",
      "wake.source": "message",
      "teaspill.run.id": "inv-msg",
      "run.outcome": "success",
    });

    // harness.run is a child of agent.wake, and agent.wake links to the gateway span.
    const msgHarness = harnessSpans.find(
      (s) => s.spanContext().traceId === msgWake!.spanContext().traceId,
    );
    expect(msgHarness!.parentSpanContext?.spanId).toBe(msgWake!.spanContext().spanId);
    // Propagation: the wake span shares the injected upstream trace id.
    expect(msgWake!.parentSpanContext).toBeDefined();
  });

  it("records a wake even when no metrics recorder is configured (no-op default)", async () => {
    const { config } = makeConfig(); // no metrics
    const world = new FakeWorld();
    await handleSpawn(world.ctx("inv-spawn"), config, { args: { task: "go" }, parentRef: null });
    // The span still lands; metrics silently no-op.
    expect(exporter.getFinishedSpans().some((s) => s.name === "agent.wake")).toBe(true);
    expect(world.state.get(AGENT_KV.status)).toBe("idle");
  });
});
