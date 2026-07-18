/**
 * 0002:T2.2 — live-gated integration smoke for the reconciler scheduling
 * wiring, against a REAL Restate stack with the reconciler object deployed.
 *
 * Skipped unless `TEASPILL_RECON_INGRESS_URL` points at a Restate INGRESS whose
 * deployment binds the `reconciler` object (the 0002:T4.1 reference deployment;
 * `createCoordinationEndpoint({ reconciler })`):
 *
 *   TEASPILL_RECON_INGRESS_URL=http://127.0.0.1:8080 \
 *     pnpm --filter @teaspill/coordination test
 *
 * WHAT THIS COVERS (concretely, now): the 0002:T2.2 scheduling seam end-to-end
 * — `createHttpReconcilerScheduleClient` → real Restate ingress →
 * `reconciler/<partition>/start` (handleStart) → a `StartResult` with a fresh
 * generation + next fire time; then `stop` (handleStop) tears the chain down.
 * This is the piece 0002:T2.2 adds; it proves the ingress path + serde are
 * correct against the live object.
 *
 * WHAT RUNS ELSEWHERE (by design): the full "induce catalog lag + a stuck
 * outbox, watch the reconciler repair both" scenario needs live AGENT objects
 * to create the drift (a wake that crashes mid-flush, a lost catalog upsert),
 * which only exist once the 0002:T4.1 reference deployment is up. That scenario
 * is owned by the 0002:T4.2 live conformance run (projection-continuity) and
 * the 0002:T4.3 chaos run (streams-kill → the catastrophic recovery path). The
 * unit suite (reconciler.test.ts / reconciler-otel.test.ts) already covers the
 * repair LOGIC over fakes end-to-end; this file covers the LIVE scheduling
 * wiring the unit fakes cannot.
 */

import { describe, expect, it } from "vitest";
import {
  createHttpReconcilerScheduleClient,
  scheduleReconcilers,
  DEFAULT_RECONCILER_SPEC,
} from "./reconciler.js";

const INGRESS_URL = process.env["TEASPILL_RECON_INGRESS_URL"];

describe.skipIf(!INGRESS_URL)(
  `live reconciler scheduling against Restate ingress ${INGRESS_URL ?? "(unset)"}`,
  () => {
    // A throwaway partition so a repeated run never touches a real deployment's
    // "default" reconciler chain.
    const partition = `t22-live-${Date.now().toString(36)}`;
    const client = () => createHttpReconcilerScheduleClient({ ingressUrl: INGRESS_URL! });

    it("start returns a fresh generation + next fire time, then stop tears it down", async () => {
      const c = client();
      const started = await c.start(partition, {
        ...DEFAULT_RECONCILER_SPEC,
        // Long interval so the smoke never actually reconciles a real fleet.
        intervalMs: 3_600_000,
      });
      expect(started.generation).toBeGreaterThanOrEqual(1);
      expect(started.nextFireAt).toBeGreaterThan(Date.now());

      // Re-start supersedes (generation-guard): the generation strictly advances.
      const restarted = await c.start(partition, { ...DEFAULT_RECONCILER_SPEC, intervalMs: 3_600_000 });
      expect(restarted.generation).toBeGreaterThan(started.generation);

      const stopped = await c.stop(partition);
      expect(stopped.wasRunning).toBe(true);
      expect(stopped.generation).toBeGreaterThan(restarted.generation);
    });

    it("scheduleReconcilers drives the live start for an explicit partition", async () => {
      const c = client();
      const res = await scheduleReconcilers({
        client: c,
        enabled: true,
        partitions: [`${partition}-bootstrap`],
        spec: { ...DEFAULT_RECONCILER_SPEC, intervalMs: 3_600_000 },
        logger: () => {},
      });
      expect(res.scheduled).toHaveLength(1);
      expect(res.scheduled[0]!.partition).toBe(`${partition}-bootstrap`);
      expect(res.scheduled[0]!.generation).toBeGreaterThanOrEqual(1);
      await c.stop(`${partition}-bootstrap`);
    });
  },
);
