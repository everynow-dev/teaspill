/**
 * T8.2 — reconciler as the fleet-wide `outbox_depth` / `projection_lag`
 * sampler (A9). Drives `reconcileEntity` with capturing fakes and asserts the
 * gauges + the unrecoverable-drift counter fire on the right conditions.
 * `projection_lag = confirmedSeq − catalog head_seq` (A6: head_seq is a floor).
 */

import { describe, expect, it } from "vitest";
import {
  reconcileEntity,
  DEFAULT_RECONCILER_SPEC,
  type EntityProbe,
  type EntitySample,
  type FlushDriveOutcome,
  type ReconcilerAlert,
  type ReconcilerDeps,
  type ReconcilerRuntimeCtx,
} from "./reconciler.js";
import type { CoordinationMetricAttrs, CoordinationMetrics } from "./otel.js";

function fakeCtx(): ReconcilerRuntimeCtx {
  return {
    key: "default",
    get: async () => null,
    set: () => {},
    clear: () => {},
    run: async (_name, action) => action(),
    genericSend: () => {},
    genericCall: async () => {
      throw new Error("unused");
    },
  };
}

function capturing(): {
  metrics: CoordinationMetrics;
  depth: { depth: number; attrs: CoordinationMetricAttrs }[];
  lag: { lag: number; attrs: CoordinationMetricAttrs }[];
  drift: CoordinationMetricAttrs[];
} {
  const depth: { depth: number; attrs: CoordinationMetricAttrs }[] = [];
  const lag: { lag: number; attrs: CoordinationMetricAttrs }[] = [];
  const drift: CoordinationMetricAttrs[] = [];
  return {
    depth,
    lag,
    drift,
    metrics: {
      recordWake: () => {},
      recordTokenSpend: () => {},
      recordOutboxDepth: (d, attrs) => depth.push({ depth: d, attrs }),
      recordProjectionLag: (l, attrs) => lag.push({ lag: l, attrs }),
      recordDrift: (attrs) => drift.push(attrs),
    },
  };
}

function deps(over: {
  probe: EntityProbe | null;
  flush?: FlushDriveOutcome;
  metrics: CoordinationMetrics;
  alerts: ReconcilerAlert[];
}): ReconcilerDeps {
  return {
    sampler: { sample: async () => [] },
    client: {
      probe: async () => over.probe,
      driveFlush: async () => over.flush ?? { kind: "flushed", headSeq: 0, appended: 0 },
      driveRecovery: async () => {},
    },
    catalog: { upsertHead: async () => {} },
    alert: { fire: (a) => over.alerts.push(a) },
    metrics: over.metrics,
  };
}

const sample = (headSeq: number | null): EntitySample => ({
  url: "/t/default/a/worker/i-1",
  type: "worker",
  status: "active",
  headSeq,
});

describe("reconciler fleet metrics (T8.2)", () => {
  it("records outbox_depth + projection_lag for a resident entity (no drift)", async () => {
    const cap = capturing();
    const alerts: ReconcilerAlert[] = [];
    const probe: EntityProbe = {
      status: "active",
      confirmedSeq: 7,
      pendingCount: 0,
      pendingFirstSeq: null,
      pendingLastSeq: null,
    };
    const report = await reconcileEntity(
      fakeCtx(),
      deps({ probe, metrics: cap.metrics, alerts }),
      sample(7),
      DEFAULT_RECONCILER_SPEC,
    );
    expect(report.drift).toBe("none");
    expect(cap.depth).toEqual([{ depth: 0, attrs: { entityType: "worker" } }]);
    expect(cap.lag).toEqual([{ lag: 0, attrs: { entityType: "worker" } }]);
    expect(cap.drift).toEqual([]);
  });

  it("computes projection_lag = confirmedSeq − catalog head_seq (A6 floor)", async () => {
    const cap = capturing();
    const alerts: ReconcilerAlert[] = [];
    const probe: EntityProbe = {
      status: "active",
      confirmedSeq: 9,
      pendingCount: 0,
      pendingFirstSeq: null,
      pendingLastSeq: null,
    };
    // catalog head_seq lags at 5 → lag 4.
    await reconcileEntity(
      fakeCtx(),
      deps({ probe, metrics: cap.metrics, alerts }),
      sample(5),
      DEFAULT_RECONCILER_SPEC,
    );
    expect(cap.lag).toEqual([{ lag: 4, attrs: { entityType: "worker" } }]);
    expect(cap.depth).toEqual([{ depth: 0, attrs: { entityType: "worker" } }]);
  });

  it("records outbox_depth from a stuck outbox and drift on unrecoverable flush", async () => {
    const cap = capturing();
    const alerts: ReconcilerAlert[] = [];
    const probe: EntityProbe = {
      status: "active",
      confirmedSeq: 4,
      pendingCount: 3,
      pendingFirstSeq: 5,
      pendingLastSeq: 7,
    };
    const report = await reconcileEntity(
      fakeCtx(),
      deps({
        probe,
        flush: { kind: "drift", message: "stream lost" },
        metrics: cap.metrics,
        alerts,
      }),
      sample(4),
      DEFAULT_RECONCILER_SPEC,
    );
    expect(report.drift).toBe("stuck_outbox");
    expect(cap.depth).toEqual([{ depth: 3, attrs: { entityType: "worker" } }]);
    expect(cap.drift).toEqual([{ entityType: "worker" }]);
    // The structured AlertSink still fires alongside the metric.
    expect(alerts.map((a) => a.kind)).toEqual(["unrecoverable_drift"]);
  });

  it("skips metrics for an absent (non-resident) entity", async () => {
    const cap = capturing();
    const alerts: ReconcilerAlert[] = [];
    await reconcileEntity(
      fakeCtx(),
      deps({ probe: null, metrics: cap.metrics, alerts }),
      sample(3),
      DEFAULT_RECONCILER_SPEC,
    );
    expect(cap.depth).toEqual([]);
    expect(cap.lag).toEqual([]);
  });
});
