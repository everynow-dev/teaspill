/**
 * 0001:T5.3 drift reconciler — unit tests over the handler logic + pure functions,
 * against in-memory fakes (the cron.ts / agent.test.ts pattern: real Restate
 * delivery, cross-object shared-read visibility, and the live
 * OutboxDriftError→recovery→epoch-reset round trip are conformance/chaos items
 * for 0001:T6.3/0001:T9.1, not covered here).
 *
 * Coverage:
 * - `classifyDrift` precedence (pure).
 * - `computeNextCursor` advance + wrap (pure).
 * - catalog-lag drift → head_seq re-upserted (monotonic GREATEST writer).
 * - stuck-outbox drift → flush re-driven.
 * - unrecoverable drift → recovery snapshot requested + historyHole + alert.
 * - a no-drift tick is a cheap no-op: it reads confirmed-seq (the probe), never
 *   the stream, and issues no repair.
 * - the sampling cursor advances across ticks and wraps at the end.
 * - the generation guard: a stale tick is a pure no-op (cron.ts discipline).
 */

import { describe, expect, it } from "vitest";
import {
  classifyDrift,
  computeNextCursor,
  handleReconcileTick,
  handleStart,
  handleStop,
  reconcileEntity,
  RECON_KV,
  RECONCILER_SERVICE_NAME,
  type AlertSink,
  type CatalogSampler,
  type EntityProbe,
  type EntityReconcileClient,
  type EntitySample,
  type FlushDriveOutcome,
  type ReconcilerAlert,
  type ReconcilerDeps,
  type ReconcilerRuntimeCtx,
  type ReconcilerSpec,
} from "./reconciler.js";
import type { OutboxCatalog, OutboxCatalogUpsert } from "./projection-outbox.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface SentCall {
  service: string;
  method: string;
  key?: string;
  parameter: unknown;
  delay?: number;
}

/**
 * Minimal `ReconcilerRuntimeCtx` over a K/V map (survives across "invocations"
 * like real Restate K/V). Records delayed self-sends. `genericCall` is
 * intentionally unimplemented — the reconcile LOGIC never calls it (it goes
 * through seams); only the real Restate client would.
 */
class FakeReconcilerCtx implements ReconcilerRuntimeCtx {
  readonly sends: SentCall[] = [];
  runCalls: string[] = [];
  constructor(
    private readonly kv: Map<string, unknown>,
    readonly key = "default",
  ) {}
  async get<T>(name: string): Promise<T | null> {
    return this.kv.has(name) ? (this.kv.get(name) as T) : null;
  }
  set<T>(name: string, value: T): void {
    this.kv.set(name, value);
  }
  clear(name: string): void {
    this.kv.delete(name);
  }
  async run<T>(name: string, action: () => T | Promise<T>): Promise<T> {
    this.runCalls.push(name);
    return action();
  }
  genericSend(call: SentCall): void {
    this.sends.push(call);
  }
  async genericCall<Res>(): Promise<Res> {
    throw new Error("genericCall must not be used by reconcile logic (use a seam)");
  }
}

/** In-memory catalog: rows keyed by url; sampler reads url-ordered pages. */
class FakeCatalog implements CatalogSampler, OutboxCatalog {
  readonly rows = new Map<string, EntitySample>();
  readonly upserts: OutboxCatalogUpsert[] = [];
  sampleCalls = 0;

  seed(rows: EntitySample[]): void {
    for (const r of rows) this.rows.set(r.url, r);
  }

  async sample(
    _ctx: ReconcilerRuntimeCtx,
    opts: { cursor: string; batchSize: number; tenant?: string },
  ): Promise<EntitySample[]> {
    this.sampleCalls += 1;
    // (tenant filtering is exercised by the real Drizzle sampler, not this fake.)
    return [...this.rows.values()]
      .filter((r) => r.url > opts.cursor)
      .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
      .slice(0, opts.batchSize);
  }

  // OutboxCatalog (monotonic GREATEST, like the real Drizzle writer)
  async upsertHead(upsert: OutboxCatalogUpsert): Promise<void> {
    this.upserts.push(upsert);
    const row = this.rows.get(upsert.entityId);
    if (row) {
      row.headSeq = row.headSeq === null ? upsert.headSeq : Math.max(row.headSeq, upsert.headSeq);
      row.status = upsert.status;
    }
  }
}

/** Programmable per-entity probe + repair recorder. */
class FakeReconcileClient implements EntityReconcileClient {
  readonly probes = new Map<string, EntityProbe | null>();
  readonly flushOutcomes = new Map<string, FlushDriveOutcome>();
  readonly probeCalls: string[] = [];
  readonly flushCalls: string[] = [];
  readonly recoveryCalls: { entityId: string; reason: string; resetEpoch: boolean }[] = [];

  async probe(_ctx: ReconcilerRuntimeCtx, entityId: string): Promise<EntityProbe | null> {
    this.probeCalls.push(entityId);
    return this.probes.has(entityId) ? this.probes.get(entityId)! : null;
  }
  async driveFlush(_ctx: ReconcilerRuntimeCtx, entityId: string): Promise<FlushDriveOutcome> {
    this.flushCalls.push(entityId);
    return this.flushOutcomes.get(entityId) ?? { kind: "flushed", headSeq: null, appended: 0 };
  }
  async driveRecovery(
    _ctx: ReconcilerRuntimeCtx,
    entityId: string,
    opts: { reason: string; resetEpoch: boolean },
  ): Promise<void> {
    this.recoveryCalls.push({ entityId, ...opts });
  }
}

class FakeAlertSink implements AlertSink {
  readonly alerts: ReconcilerAlert[] = [];
  fire(alert: ReconcilerAlert): void {
    this.alerts.push(alert);
  }
}

function makeDeps(): {
  deps: ReconcilerDeps;
  catalog: FakeCatalog;
  client: FakeReconcileClient;
  alert: FakeAlertSink;
} {
  const catalog = new FakeCatalog();
  const client = new FakeReconcileClient();
  const alert = new FakeAlertSink();
  return { deps: { sampler: catalog, client, catalog, alert }, catalog, client, alert };
}

const SPEC: ReconcilerSpec = { intervalMs: 60_000, batchSize: 50, allowEpochReset: false };

function url(n: number): string {
  return `/t/default/a/tester/i-${n}`;
}

function probe(over: Partial<EntityProbe> = {}): EntityProbe {
  return {
    status: "idle",
    confirmedSeq: null,
    pendingCount: 0,
    pendingFirstSeq: null,
    pendingLastSeq: null,
    ...over,
  };
}

function sample(over: Partial<EntitySample> & { url: string }): EntitySample {
  return { type: "tester", status: "idle", headSeq: null, ...over };
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("classifyDrift", () => {
  it("flags a non-empty pending outbox as stuck_outbox (highest precedence)", () => {
    // Even when the catalog also lags, stuck_outbox wins — its flush subsumes it.
    expect(classifyDrift({ catalogHeadSeq: 1, confirmedSeq: 5, pendingCount: 3 })).toBe(
      "stuck_outbox",
    );
  });

  it("flags catalog head_seq behind confirmed as catalog_lag (0001:A6#5 floor)", () => {
    expect(classifyDrift({ catalogHeadSeq: 4, confirmedSeq: 7, pendingCount: 0 })).toBe(
      "catalog_lag",
    );
  });

  it("treats a null catalog head_seq with a real confirmed as catalog_lag", () => {
    expect(classifyDrift({ catalogHeadSeq: null, confirmedSeq: 0, pendingCount: 0 })).toBe(
      "catalog_lag",
    );
  });

  it("is none when catalog head_seq == confirmed and nothing pending", () => {
    expect(classifyDrift({ catalogHeadSeq: 9, confirmedSeq: 9, pendingCount: 0 })).toBe("none");
  });

  it("is none when nothing has ever been confirmed and nothing is pending", () => {
    expect(classifyDrift({ catalogHeadSeq: null, confirmedSeq: null, pendingCount: 0 })).toBe(
      "none",
    );
  });

  it("does not flag a catalog head_seq AHEAD of confirmed (never < confirmed)", () => {
    // Anomalous but not a drift the reconciler repairs (head_seq is a floor,
    // never expected to exceed confirmed under normal operation).
    expect(classifyDrift({ catalogHeadSeq: 12, confirmedSeq: 9, pendingCount: 0 })).toBe("none");
  });
});

describe("computeNextCursor", () => {
  const rows = (urls: string[]): EntitySample[] => urls.map((u) => sample({ url: u }));

  it("advances to the last url on a full page", () => {
    expect(computeNextCursor(rows([url(1), url(2), url(3)]), 3)).toEqual({
      nextCursor: url(3),
      wrapped: false,
    });
  });

  it("wraps to the start on a short page (end of the url space)", () => {
    expect(computeNextCursor(rows([url(1), url(2)]), 3)).toEqual({ nextCursor: "", wrapped: true });
  });

  it("wraps on an empty page", () => {
    expect(computeNextCursor([], 3)).toEqual({ nextCursor: "", wrapped: true });
  });
});

// ---------------------------------------------------------------------------
// reconcileEntity — the three drift classes + repairs
// ---------------------------------------------------------------------------

describe("reconcileEntity", () => {
  it("catalog-lag drift is repaired by re-upserting head_seq (GREATEST)", async () => {
    const { deps, catalog, client } = makeDeps();
    catalog.seed([sample({ url: url(1), headSeq: 4 })]);
    client.probes.set(url(1), probe({ confirmedSeq: 7, status: "idle" }));
    const ctx = new FakeReconcilerCtx(new Map());

    const report = await reconcileEntity(ctx, deps, catalog.rows.get(url(1))!, SPEC);

    expect(report).toEqual({ entityId: url(1), drift: "catalog_lag", action: "catalog_lag_repaired" });
    expect(catalog.upserts).toEqual([{ entityId: url(1), headSeq: 7, status: "idle" }]);
    expect(catalog.rows.get(url(1))!.headSeq).toBe(7); // GREATEST(4, 7)
    // No stream contact / flush — catalog-lag is the cheap repair.
    expect(client.flushCalls).toEqual([]);
  });

  it("stuck-outbox drift re-drives the entity's flush", async () => {
    const { deps, client } = makeDeps();
    const s = sample({ url: url(2), headSeq: 5 });
    client.probes.set(url(2), probe({ confirmedSeq: 5, pendingCount: 3, pendingFirstSeq: 6, pendingLastSeq: 8 }));
    client.flushOutcomes.set(url(2), { kind: "flushed", headSeq: 8, appended: 3 });
    const ctx = new FakeReconcilerCtx(new Map());

    const report = await reconcileEntity(ctx, deps, s, SPEC);

    expect(report).toEqual({ entityId: url(2), drift: "stuck_outbox", action: "flush_redriven" });
    expect(client.flushCalls).toEqual([url(2)]);
  });

  it("unrecoverable drift (flush returns drift) fires an alert + requests recovery", async () => {
    const { deps, client, alert } = makeDeps();
    const s = sample({ url: url(3), headSeq: 2 });
    client.probes.set(
      url(3),
      probe({ confirmedSeq: 2, pendingCount: 2, pendingFirstSeq: 3, pendingLastSeq: 4 }),
    );
    client.flushOutcomes.set(url(3), { kind: "drift", message: "producer seq gap: stream rolled back" });
    const ctx = new FakeReconcilerCtx(new Map());

    const report = await reconcileEntity(ctx, deps, s, SPEC);

    // allowEpochReset defaults false ⇒ recovery is GATED (marked, not reset).
    expect(report).toEqual({ entityId: url(3), drift: "stuck_outbox", action: "recovery_gated" });
    expect(alert.alerts).toHaveLength(1);
    expect(alert.alerts[0]!.kind).toBe("unrecoverable_drift");
    expect(alert.alerts[0]!.entityId).toBe(url(3));
    expect(client.recoveryCalls).toEqual([
      { entityId: url(3), reason: "producer seq gap: stream rolled back", resetEpoch: false },
    ]);
  });

  it("unrecoverable drift with allowEpochReset authorizes the reset (0001:A6#6 gate)", async () => {
    const { deps, client } = makeDeps();
    const s = sample({ url: url(4), headSeq: 2 });
    client.probes.set(url(4), probe({ confirmedSeq: 2, pendingCount: 1, pendingFirstSeq: 3, pendingLastSeq: 3 }));
    client.flushOutcomes.set(url(4), { kind: "drift", message: "closed stream" });
    const ctx = new FakeReconcilerCtx(new Map());

    const report = await reconcileEntity(ctx, deps, s, { ...SPEC, allowEpochReset: true });

    expect(report.action).toBe("recovery_snapshot");
    expect(client.recoveryCalls[0]!.resetEpoch).toBe(true);
  });

  it("a no-drift entity is a cheap no-op: probe read only, no flush, no upsert", async () => {
    const { deps, catalog, client } = makeDeps();
    const s = sample({ url: url(5), headSeq: 9 });
    client.probes.set(url(5), probe({ confirmedSeq: 9, pendingCount: 0 }));
    const ctx = new FakeReconcilerCtx(new Map());

    const report = await reconcileEntity(ctx, deps, s, SPEC);

    expect(report).toEqual({ entityId: url(5), drift: "none", action: "ok" });
    expect(client.probeCalls).toEqual([url(5)]); // the cheap confirmed-seq read (0001:A6#4)
    expect(client.flushCalls).toEqual([]); // no stream contact
    expect(catalog.upserts).toEqual([]); // no catalog write
  });

  it("skips an archived catalog row without probing (K/V is cleared, 0001:D7)", async () => {
    const { deps, client } = makeDeps();
    const s = sample({ url: url(6), status: "archived", headSeq: 3 });
    const ctx = new FakeReconcilerCtx(new Map());

    const report = await reconcileEntity(ctx, deps, s, SPEC);

    expect(report.action).toBe("skipped_archived");
    expect(client.probeCalls).toEqual([]);
  });

  it("skips an entity absent from Restate K/V (probe returns null)", async () => {
    const { deps, client } = makeDeps();
    const s = sample({ url: url(7), headSeq: 1 });
    client.probes.set(url(7), null);
    const ctx = new FakeReconcilerCtx(new Map());

    const report = await reconcileEntity(ctx, deps, s, SPEC);

    expect(report.action).toBe("skipped_absent");
    expect(client.flushCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleReconcileTick — batching, cursor, reschedule, generation guard
// ---------------------------------------------------------------------------

describe("handleReconcileTick", () => {
  async function startAndTakeTick(
    ctx: FakeReconcilerCtx,
    deps: ReconcilerDeps,
    spec: ReconcilerSpec,
  ): Promise<{ generation: number; msg: { generation: number; scheduledFor: number } }> {
    const start = await handleStart(ctx, spec);
    // The delayed self-send carries the tick message we replay.
    const send = ctx.sends.at(-1)!;
    expect(send.service).toBe(RECONCILER_SERVICE_NAME);
    expect(send.method).toBe("tick");
    return { generation: start.generation, msg: send.parameter as { generation: number; scheduledFor: number } };
  }

  it("reconciles a batch and repairs a mix of drift classes in one tick", async () => {
    const { deps, catalog, client } = makeDeps();
    catalog.seed([
      sample({ url: url(1), headSeq: 9 }), // no drift
      sample({ url: url(2), headSeq: 1 }), // catalog lag
      sample({ url: url(3), headSeq: 4 }), // stuck outbox
    ]);
    client.probes.set(url(1), probe({ confirmedSeq: 9 }));
    client.probes.set(url(2), probe({ confirmedSeq: 6 }));
    client.probes.set(url(3), probe({ confirmedSeq: 4, pendingCount: 2, pendingFirstSeq: 5, pendingLastSeq: 6 }));
    client.flushOutcomes.set(url(3), { kind: "flushed", headSeq: 6, appended: 2 });

    const kv = new Map<string, unknown>();
    const ctx = new FakeReconcilerCtx(kv);
    const { msg } = await startAndTakeTick(ctx, deps, SPEC);

    const result = await handleReconcileTick(ctx, deps, msg);
    if (!result.fired) throw new Error("expected fired tick");

    expect(result.checked).toBe(3);
    expect(result.reports.map((r) => r.action)).toEqual([
      "ok",
      "catalog_lag_repaired",
      "flush_redriven",
    ]);
    expect(catalog.upserts).toEqual([{ entityId: url(2), headSeq: 6, status: "idle" }]);
    expect(client.flushCalls).toEqual([url(3)]);
  });

  it("advances the cursor across ticks and wraps at the end (round-robin)", async () => {
    const { deps, catalog, client } = makeDeps();
    // 3 entities, batchSize 2 → tick1 sees i-1,i-2; tick2 sees i-3 (short → wrap);
    // tick3 restarts at i-1,i-2.
    for (const n of [1, 2, 3]) {
      catalog.seed([sample({ url: url(n), headSeq: 0 })]);
      client.probes.set(url(n), probe({ confirmedSeq: 0 })); // no drift
    }
    const spec: ReconcilerSpec = { ...SPEC, batchSize: 2 };
    const kv = new Map<string, unknown>();
    const ctx = new FakeReconcilerCtx(kv);
    const { msg } = await startAndTakeTick(ctx, deps, spec);

    const t1 = await handleReconcileTick(ctx, deps, msg);
    if (!t1.fired) throw new Error("t1");
    expect(t1.checked).toBe(2);
    expect(t1.cursor).toBe(url(2));
    expect(t1.wrapped).toBe(false);
    expect(kv.get(RECON_KV.cursor)).toBe(url(2));

    // Replay the message the tick self-sent (same generation).
    const msg2 = ctx.sends.at(-1)!.parameter as typeof msg;
    const t2 = await handleReconcileTick(ctx, deps, msg2);
    if (!t2.fired) throw new Error("t2");
    expect(t2.checked).toBe(1); // only i-3 remains past the cursor
    expect(t2.wrapped).toBe(true); // short page → wrap
    expect(t2.cursor).toBe("");
    expect(kv.get(RECON_KV.cursor)).toBe("");

    const msg3 = ctx.sends.at(-1)!.parameter as typeof msg;
    const t3 = await handleReconcileTick(ctx, deps, msg3);
    if (!t3.fired) throw new Error("t3");
    expect(t3.checked).toBe(2); // restarted at the beginning
    expect(t3.cursor).toBe(url(2));
  });

  it("reschedules the next tick with the same generation", async () => {
    const { deps, catalog } = makeDeps();
    catalog.seed([]);
    const kv = new Map<string, unknown>();
    const ctx = new FakeReconcilerCtx(kv);
    const { generation, msg } = await startAndTakeTick(ctx, deps, SPEC);

    const before = ctx.sends.length;
    const result = await handleReconcileTick(ctx, deps, msg);
    if (!result.fired) throw new Error("expected fired");
    const reschedule = ctx.sends.at(-1)!;
    expect(ctx.sends.length).toBe(before + 1);
    expect(reschedule.method).toBe("tick");
    expect((reschedule.parameter as { generation: number }).generation).toBe(generation);
    expect(reschedule.delay).toBe(SPEC.intervalMs);
  });

  it("a stale tick (superseded generation) is a pure no-op — no sample, no reschedule", async () => {
    const { deps, catalog } = makeDeps();
    catalog.seed([sample({ url: url(1), headSeq: 0 })]);
    const kv = new Map<string, unknown>();
    const ctx = new FakeReconcilerCtx(kv);
    const { msg: staleMsg } = await startAndTakeTick(ctx, deps, SPEC);

    // A second start() bumps the generation, superseding the first chain.
    await handleStart(ctx, SPEC);
    const sampleCallsBefore = catalog.sampleCalls;
    const sendsBefore = ctx.sends.length;

    const result = await handleReconcileTick(ctx, deps, staleMsg);
    expect(result).toEqual({ fired: false, reason: "stale-generation" });
    expect(catalog.sampleCalls).toBe(sampleCallsBefore); // never sampled
    expect(ctx.sends.length).toBe(sendsBefore); // never rescheduled
  });

  it("stop() bumps the generation so the running chain dies", async () => {
    const { deps, catalog } = makeDeps();
    catalog.seed([]);
    const kv = new Map<string, unknown>();
    const ctx = new FakeReconcilerCtx(kv);
    const { msg } = await startAndTakeTick(ctx, deps, SPEC);

    const stop = await handleStop(ctx);
    expect(stop.wasRunning).toBe(true);
    expect(kv.has(RECON_KV.spec)).toBe(false);

    const result = await handleReconcileTick(ctx, deps, msg);
    // Generation bumped by stop() ⇒ the pending tick is stale.
    expect(result.fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleStart validation
// ---------------------------------------------------------------------------

describe("handleStart", () => {
  it("rejects a non-positive interval", async () => {
    const ctx = new FakeReconcilerCtx(new Map());
    await expect(handleStart(ctx, { ...SPEC, intervalMs: 0 })).rejects.toThrow(/intervalMs/);
  });

  it("rejects a batchSize < 1", async () => {
    const ctx = new FakeReconcilerCtx(new Map());
    await expect(handleStart(ctx, { ...SPEC, batchSize: 0 })).rejects.toThrow(/batchSize/);
  });

  it("schedules the first tick and stores the spec + generation", async () => {
    const kv = new Map<string, unknown>();
    const ctx = new FakeReconcilerCtx(kv);
    const result = await handleStart(ctx, SPEC);
    expect(result.generation).toBe(1);
    expect(kv.get(RECON_KV.spec)).toEqual(SPEC);
    expect(ctx.sends.at(-1)!.delay).toBe(SPEC.intervalMs);
  });
});
