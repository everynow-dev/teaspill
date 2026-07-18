/**
 * 0001:T8.2 observability — executor plane.
 *
 * 1. `workspace_pool` gauge fires on host pool mutations (ensure / exec /
 *    dispose) with active-workspace + running-exec samples (fake meter).
 * 2. `handleExec` opens a `workspace.exec` span with the right attributes,
 *    parented under a trace context extracted from the exec envelope
 *    (in-memory span exporter). Uses a REAL local adapter + host behind a
 *    trimmed fake Restate ctx (the workspace.test.ts pattern).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ROOT_CONTEXT, type Gauge, type Meter } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ExecutorHost, type AwakeableResolver, type HostWorkspaceRef } from "./host.js";
import { createDirectHostClient } from "./host-client.js";
import { createLocalAdapter } from "./local-adapter.js";
import { handleEnsure, handleExec, type WorkspaceObjectConfig } from "./workspace.js";
import {
  WorkspaceExecTimeoutError,
  WorkspaceInterruptedError,
  type WorkspaceAwakeable,
  type WorkspaceRuntimeCtx,
} from "./workspace-runtime.js";
import {
  createOtelExecutorMetrics,
  extractTraceContext,
  type ExecutorMetrics,
} from "./otel.js";

// ---------------------------------------------------------------------------
// In-memory tracer
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
// Fake meter
// ---------------------------------------------------------------------------

interface MeterRecord {
  name: string;
  value: number;
}

function fakeMeter(): { meter: Meter; records: MeterRecord[] } {
  const records: MeterRecord[] = [];
  const gauge = (name: string): Gauge =>
    ({ record: (value: number) => records.push({ name, value }) }) as unknown as Gauge;
  const meter = {
    createGauge: (name: string) => gauge(name),
    createCounter: (name: string) => gauge(name),
    createUpDownCounter: (name: string) => gauge(name),
    createHistogram: (name: string) => gauge(name),
  } as unknown as Meter;
  return { meter, records };
}

// ---------------------------------------------------------------------------
// Trimmed fake workspace ctx (workspace.test.ts pattern, happy path only)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeWorld {
  readonly state = new Map<string, unknown>();
  readonly awakeables = new Map<string, Deferred<unknown>>();
  private seq = 0;
  constructor(readonly key: string) {}

  readonly resolver: AwakeableResolver = async (id, payload) => {
    this.awakeables.get(id)?.resolve(payload);
  };

  private nextAwakeableId(): string {
    return `awk-${++this.seq}`;
  }

  ctx(invocationId: string): WorkspaceRuntimeCtx {
    const { state, awakeables, key } = this;
    const newId = (): string => this.nextAwakeableId();
    return {
      key,
      invocationId,
      get: async <T>(name: string): Promise<T | null> =>
        state.has(name) ? (state.get(name) as T) : null,
      set: <T>(name: string, value: T): void => {
        state.set(name, value);
      },
      clear: (name: string): void => {
        state.delete(name);
      },
      run: async <T>(_name: string, action: () => T | Promise<T>): Promise<T> => action(),
      genericCall: () => {
        throw new Error("unused (direct host client)");
      },
      awakeable: <T>(): WorkspaceAwakeable<T> => {
        const id = newId();
        const d = deferred<unknown>();
        awakeables.set(id, d);
        return { id, promise: d.promise as Promise<T> };
      },
      awaitAwakeable: <T>(awakeable: WorkspaceAwakeable<T>, timeoutMs: number): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => reject(new WorkspaceExecTimeoutError()), timeoutMs);
          void awakeable.promise.then(
            (v) => {
              clearTimeout(timer);
              resolve(v as T);
            },
            (err: unknown) => {
              clearTimeout(timer);
              reject(err instanceof Error ? err : new WorkspaceInterruptedError());
            },
          );
        }),
    };
  }
}

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "teaspill-exec-otel-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function makeHost(metrics?: ExecutorMetrics): ExecutorHost {
  const world = new FakeWorld("default/ws-1");
  return new ExecutorHost({
    adapters: { local: createLocalAdapter({ baseDir: base, quiet: true }) },
    resolveAwakeable: world.resolver,
    resolveRetries: 0,
    ...(metrics !== undefined && { metrics }),
  });
}

const ref = (key: string): HostWorkspaceRef => ({ workspaceKey: key, config: { adapter: "local" } });

// ---------------------------------------------------------------------------
// 1. workspace_pool gauge
// ---------------------------------------------------------------------------

describe("workspace_pool gauge", () => {
  it("createOtelExecutorMetrics records active workspaces + running execs (fake meter)", () => {
    const { meter, records } = fakeMeter();
    const m = createOtelExecutorMetrics(meter);
    m.recordWorkspacePool({ activeWorkspaces: 2, runningExecs: 1 });
    expect(records).toEqual([
      { name: "workspace_pool", value: 2 },
      { name: "workspace_pool_execs", value: 1 },
    ]);
  });

  it("samples the pool on host ensure and dispose", async () => {
    const samples: { activeWorkspaces: number; runningExecs: number }[] = [];
    const metrics: ExecutorMetrics = { recordWorkspacePool: (s) => samples.push(s) };
    const host = makeHost(metrics);

    await host.ensure(ref("default/ws-a"));
    await host.ensure(ref("default/ws-b"));
    expect(samples.at(-1)).toEqual({ activeWorkspaces: 2, runningExecs: 0 });

    await host.dispose({ ref: ref("default/ws-a") });
    expect(samples.at(-1)).toEqual({ activeWorkspaces: 1, runningExecs: 0 });
  });
});

// ---------------------------------------------------------------------------
// 2. workspace.exec span
// ---------------------------------------------------------------------------

describe("workspace.exec span", () => {
  it("opens a workspace.exec span with exec attributes on a completed exec", async () => {
    const world = new FakeWorld("default/ws-1");
    const host = new ExecutorHost({
      adapters: { local: createLocalAdapter({ baseDir: base, quiet: true }) },
      resolveAwakeable: world.resolver,
      resolveRetries: 0,
    });
    const config: WorkspaceObjectConfig = { host: createDirectHostClient(host) };

    await handleEnsure(world.ctx("inv-ensure"), config, { config: { adapter: "local" } });
    const result = await handleExec(world.ctx("inv-exec"), config, {
      command: "echo hi",
      execId: "e-1",
    });
    expect(result.outcome).toBe("completed");

    const span = exporter.getFinishedSpans().find((s) => s.name === "workspace.exec");
    expect(span).toBeDefined();
    expect(span!.attributes).toMatchObject({
      "teaspill.workspace.key": "default/ws-1",
      "teaspill.exec.id": "e-1",
      "teaspill.exec.outcome": "completed",
      "teaspill.exec.exit_code": 0,
    });
  });

  it("parents the exec span under a traceparent supplied on the exec envelope", async () => {
    const world = new FakeWorld("default/ws-1");
    const host = new ExecutorHost({
      adapters: { local: createLocalAdapter({ baseDir: base, quiet: true }) },
      resolveAwakeable: world.resolver,
      resolveRetries: 0,
    });
    const config: WorkspaceObjectConfig = { host: createDirectHostClient(host) };
    await handleEnsure(world.ctx("inv-ensure"), config, { config: { adapter: "local" } });

    // A well-formed W3C traceparent threaded on the envelope (best-effort — the
    // harness tool client is the injector in prod; here we assert extraction).
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    await handleExec(world.ctx("inv-exec-2"), config, {
      command: "echo hi",
      execId: "e-2",
      traceparent: `00-${traceId}-${spanId}-01`,
    });

    const span = exporter.getFinishedSpans().find((s) => s.name === "workspace.exec");
    expect(span!.spanContext().traceId).toBe(traceId);
    expect(span!.parentSpanContext?.spanId).toBe(spanId);
  });

  it("extractTraceContext returns ROOT when no traceparent is present", () => {
    expect(extractTraceContext({ command: "echo hi" })).toBe(ROOT_CONTEXT);
  });
});
