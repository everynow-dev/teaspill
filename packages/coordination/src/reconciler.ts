/**
 * `reconciler/<partition>` — 0001:T5.3: the drift reconciler + repair loop (0001:D3).
 *
 * A cron-style self-rescheduling Restate virtual object (same generation-guard
 * discipline as `cron.ts`) that periodically SAMPLES a bounded batch of
 * catalog entities and, for each, compares the catalog's `head_seq` against
 * the entity's own last-confirmed seq to detect and repair projection drift
 * (0001:D3 / DECISIONS 0001:A6). It is the counterpart to the outbox (0001:T2.2): the outbox
 * keeps a single entity's projection exactly-once on the hot path; the
 * reconciler is the periodic backstop that heals the residue the crash matrix
 * documents (catalog lag, stuck outbox, catastrophic stream loss).
 *
 * ## The cheap confirmed-seq read (0001:A6#4 — no stream scan)
 *
 * PLAN 0001:T5.3 anticipates: reading a stream's tail seq is expensive (a scan);
 * instead the outbox tracks `outboxConfirmedSeq` in the entity's K/V at trim
 * time (DECISIONS 0001:A6#4). The reconciler reads THAT — via a cheap shared-read
 * probe on the agent object — never the stream. So a no-drift tick costs one
 * catalog batch read + one K/V probe per entity and zero stream I/O.
 *
 * ## Two sources, one comparison
 *
 * - Catalog `entities.head_seq` (Postgres, sampled in a batch): the last
 *   CONFIRMED seq the projection upserted. DECISIONS 0001:A6#5: this is a FLOOR,
 *   not exact — a crash between the outbox trim and the catalog upsert leaves
 *   it lagging the entity's true `outboxConfirmedSeq` by one flush.
 * - Entity K/V `outboxConfirmedSeq` + pending-outbox depth (the probe): the
 *   ground truth for what the entity has actually confirmed / still owes.
 *
 * ## The three drift classes + repairs (PLAN 0001:T5.3)
 *
 * 1. **`catalog_lag`** — `head_seq < confirmedSeq` (the 0001:A6#5 floor case, or a
 *    lost catalog upsert). Repair: re-drive the catalog `head_seq` upsert to
 *    `confirmedSeq` (idempotent, monotonic GREATEST — `projection-catalog.ts`).
 *    Cheap; no stream contact.
 * 2. **`stuck_outbox`** — the entity's pending outbox is non-empty (events
 *    staged but not confirmed onto the stream — a wake that crashed before its
 *    opening flush completed, or an entity that went idle mid-flush). Repair:
 *    re-drive the entity's outbox `flush` (idempotent per 0001:T2.2 — in-order
 *    replay from the first unconfirmed, duplicates dedup). This pushes the
 *    stuck events and advances both `confirmedSeq` and the catalog.
 * 3. **`unrecoverable`** — a `stuck_outbox` whose flush cannot make progress:
 *    the flush surfaces `OutboxDriftError` (producer seq gap below the first
 *    unconfirmed ⇒ stream genuinely lost / rolled back; fenced epoch; closed
 *    stream — none fixable by in-order replay). Repair (0001:D3 catastrophic path):
 *    ask the entity to emit a `state_snapshot(reason:'recovery',
 *    historyHole:true)` and CONTINUE, and fire a structured ALERT (the
 *    `AlertSink` seam 0001:T8.2 wires to metrics/paging). See "history hole" below.
 *
 * ## History-hole marker (PLAN "history_hole marker event")
 *
 * PLAN 0001:T5.3 asks for a "history_hole marker event". The FROZEN v1 schema
 * (DECISIONS 0001:A5) has no distinct `history_hole` event type; instead the
 * `state_snapshot` payload carries `historyHole: true`
 * (`stateSnapshotPayloadSchema`, events.ts). We represent the hole THAT way —
 * the recovery snapshot is itself the marker: a complete state as of its own
 * seq, flagged so consumers (0001:T5.2 fast-join `selectFastJoinSnapshot`,
 * `checkSeqContiguity`) know not to gap-check across it. No new event type is
 * introduced; this stays additive-only under the freeze. (If a deployment
 * later wants a distinct machine signal, it rides `opaque` — but v1 does not.)
 *
 * ## 0001:A9 — epoch/offset resolution (designed at 0001:T5.3, BUILT by 0002:T2.1)
 *
 * DECISIONS 0001:A6#6 left open: a producer epoch bump/reset breaks the
 * `Producer-Seq == canonical seq` identity (0001:A1) and would need a per-producer
 * offset. Resolution (0001:A9, now implemented):
 *
 * - The reconciler's AUTOMATIC repairs — `catalog_lag` (a pure catalog write)
 *   and `stuck_outbox` (in-order flush REPLAY at the *existing* epoch) — NEVER
 *   bump the epoch. `Producer-Seq == seq` holds throughout. For these paths,
 *   0001:A6#6 is a documented non-issue.
 * - The catastrophic reset (writing a recovery snapshot onto a genuinely-lost
 *   stream, where in-order replay can't proceed) is the only path that needs a
 *   new epoch. The identity survives via the affine map `Producer-Seq =
 *   canonicalSeq - producerSeqOffset`, with `outboxProducerSeqOffset`
 *   persisted in the entity K/V beside `outboxProducerEpoch`
 *   (projection-outbox.ts, 0002:T2.1). Normal operation is offset 0, epoch 0 ⇒
 *   `Producer-Seq == seq` (0001:A1 unchanged). A reset at canonical seq N sets
 *   `epoch = E+1` and `offset = N`: the recovery `state_snapshot` appends at
 *   `Producer-Seq 0` under the new epoch (satisfying the server's "a new epoch
 *   must start at seq 0" rule), while its canonical `seq` stays N (gapless
 *   continuation, 0001:A1 preserved for every reader); subsequent events append at
 *   `Producer-Seq = seq - N`. Readers/dedup/context are entirely
 *   canonical-seq based (0001:A6#2), so epoch+offset are invisible above the
 *   outbox.
 * - THE SPLIT (0001:A9, kept exactly): the reconciler DETECTS the
 *   unrecoverable condition, ALERTS, and REQUESTS recovery through the
 *   `EntityReconcileClient` seam; the agent object EXECUTES it —
 *   `handleReconcileRecovery` (projection-outbox.ts), wired as the exclusive
 *   `reconcileRecovery` handler in agent.ts. The single-writer owns the
 *   outbox K/V; this module never mutates it. The destructive step is doubly
 *   guarded: `ReconcilerSpec.allowEpochReset` authorizes it (default TRUE
 *   since 0002:T2.1 — the Gate 1 property suite covers the reset path;
 *   see the spec doc), and the agent object re-verifies the drift with a
 *   live flush inside its own invocation before touching the epoch.
 *
 * ## Sampling / cursor (round-robin, oldest-checked-first)
 *
 * The reconciler keeps its OWN cursor in K/V (`RECON_KV.cursor`, a url
 * high-water mark). Each tick samples `WHERE url > cursor ORDER BY url LIMIT
 * batchSize`; a short page means the end was reached, so the cursor WRAPS to
 * `""` (which is `< ` every url) and the next tick starts from the beginning.
 * Over successive ticks every entity is visited round-robin; there is no
 * per-row "last checked" column to maintain (keeping catalog writes to the
 * repair path only, 0001:D1). Cadence is `intervalMs` between ticks (default 60s),
 * `batchSize` entities per tick (default 50) — tune per deployment scale.
 *
 * ## What's pure vs what needs a live runtime (as cron.ts / agent.ts)
 *
 * - `classifyDrift` and `computeNextCursor` are pure — unit-tested directly.
 * - `handleStart` / `handleStop` / `handleReconcileTick` are handler LOGIC
 *   written against the small `ReconcilerRuntimeCtx` + seam interfaces
 *   (`CatalogSampler`, `EntityReconcileClient`, `OutboxCatalog`, `AlertSink`),
 *   unit-tested against in-memory fakes. What the fakes canNOT cover — real
 *   delayed-send delivery, cross-object shared-read visibility timing, replay
 *   of a crashed `ctx.run`, the actual OutboxDriftError→recovery→epoch-reset
 *   round trip — is a live conformance item (0001:T6.3) and a chaos target (0001:T9.1),
 *   exactly as SPIKE-RESTATE.md prescribes.
 */

import * as restate from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk";
import { eq, and, gt, asc, type SQL } from "drizzle-orm";
import { entities, type CatalogDb } from "@teaspill/catalog";
import type { EntityStatus } from "./agent-runtime.js";
import { agentTargetOf } from "./agent-seams.js";
import type { OutboxCatalog, ReconcileRecoveryResult } from "./projection-outbox.js";
import { NOOP_COORDINATION_METRICS, type CoordinationMetrics } from "./otel.js";

/** Restate service name for the reconciler object (docs/addressing.md style; see cron.ts). */
export const RECONCILER_SERVICE_NAME = "reconciler";

/**
 * Default partition key when a deployment runs a single reconciler. Multiple
 * partitions (e.g. one per tenant) are just distinct keys — each owns an
 * independent cursor + tick chain, so they never contend (single-writer per
 * key, 0001:D2).
 */
export const DEFAULT_RECONCILER_PARTITION = "default";

// ---------------------------------------------------------------------------
// K/V layout (this object's own state — cursor + generation guard)
// ---------------------------------------------------------------------------

export const RECON_KV = {
  /** `number` — generation guard (cron.ts discipline). Bumped by start/stop. */
  generation: "generation",
  /** `ReconcilerSpec` — the active loop config; absent ⇒ stopped. */
  spec: "spec",
  /**
   * `string` — round-robin cursor: the greatest entity url visited on the last
   * tick. Next tick samples `url > cursor`. `""` (or absent) ⇒ start from the
   * beginning of the url space.
   */
  cursor: "cursor",
  /** `number` — epoch ms of the last completed tick (introspection only). */
  lastTickAt: "lastTickAt",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `start(spec)` request body; also persisted in K/V. */
export interface ReconcilerSpec {
  /** Ms between ticks. Must be > 0. */
  intervalMs: number;
  /** Entities sampled + checked per tick. Must be >= 1. */
  batchSize: number;
  /**
   * Optional tenant filter (addressing §8): a partition that only reconciles
   * one tenant's entities. Omitted ⇒ all entities in the catalog.
   */
  tenant?: string;
  /**
   * Gate for the destructive catastrophic reset (0001:A9 epoch bump). Default
   * TRUE since 0002:T2.1: the affine-offset append + agent-object
   * `reconcileRecovery` executor are built and the reset path is covered by
   * the Gate 1 property suite (arbitrary crash schedules across reset
   * boundaries — see projection-outbox.test.ts). The reset stays
   * evidence-gated at the point of execution: the agent object re-verifies
   * the drift with a live flush inside its own exclusive handler before
   * touching the epoch (`handleReconcileRecovery`), so a spurious request is
   * a no-op. Set false to restore the 0001:A9 alert-only stance (the
   * reconciler then marks `recovery_gated` and the entity stays stuck until
   * ops intervene).
   */
  allowEpochReset?: boolean;
}

export const DEFAULT_RECONCILER_SPEC: ReconcilerSpec = {
  intervalMs: 60_000,
  batchSize: 50,
  allowEpochReset: true,
};

interface TickMessage {
  /** Generation this tick chain was minted under (the guard's key input). */
  generation: number;
  /** Epoch ms this tick was scheduled to fire at. Informational (see cron.ts). */
  scheduledFor: number;
}

/** One catalog row as sampled for reconciliation (the cheap columns only). */
export interface EntitySample {
  url: string;
  type: string;
  status: EntityStatus;
  /** `entities.head_seq` — last CONFIRMED seq per the catalog; null ⇒ nothing confirmed yet (0001:A6#5 floor). */
  headSeq: number | null;
}

/** The cheap per-entity K/V read (0001:A6#4): confirmed-seq + pending-outbox depth. No stream scan. */
export interface EntityProbe {
  status: EntityStatus;
  /** `outboxConfirmedSeq` from the entity K/V; null ⇒ nothing ever confirmed (or K/V cleared by archive). */
  confirmedSeq: number | null;
  /** Number of events staged-but-unconfirmed in the entity's pending outbox. */
  pendingCount: number;
  /** seq of the first pending event, when any (else null). */
  pendingFirstSeq: number | null;
  /** seq of the last pending event, when any (else null). */
  pendingLastSeq: number | null;
}

/** Result of asking an entity to re-drive its outbox flush. */
export type FlushDriveOutcome =
  /** Flush made progress (or the outbox was already empty). `headSeq` = confirmed tail. */
  | { kind: "flushed"; headSeq: number | null; appended: number }
  /**
   * The flush surfaced `OutboxDriftError` — in-order replay cannot fix this
   * (gap below first-unconfirmed, fenced epoch, closed stream). This is the
   * `unrecoverable` trigger.
   */
  | { kind: "drift"; message: string };

export type DriftClass = "none" | "catalog_lag" | "stuck_outbox";

/**
 * What a single entity's reconciliation did this tick. The `recovery_*` family
 * reflects the ACTUAL outcome the agent object reported from
 * `handleReconcileRecovery` (0002:T2.1), not merely what the reconciler
 * requested — so a held/healed/failed recovery is never mislabeled as a
 * performed snapshot (0002:T2.2 fix of the T2.1 cosmetic follow-up):
 *
 * - `recovery_snapshot` — the epoch-reset ran and a `state_snapshot(recovery)`
 *   was written (`performed: true`).
 * - `recovery_gated`    — `allowEpochReset` was false; nothing was touched.
 * - `recovery_held`     — the stream is CLOSED: a reset can never append to it,
 *   so the agent object alert-and-HOLDs (nothing written, no per-tick snapshot/
 *   epoch churn). The reconciler still ALERTS every tick; this is the accurate
 *   action for a held closed stream.
 * - `recovery_healed`   — the agent object's re-verification flush succeeded
 *   (the drift healed between the reconciler probe and the recovery handler);
 *   no reset was needed.
 * - `recovery_failed`   — the reset could not be performed (e.g. the recovery
 *   snapshot exceeds a size budget); K/V was fully restored, the pending outbox
 *   stays intact for a later retry.
 */
export type RepairAction =
  | "ok"
  | "skipped_absent"
  | "skipped_archived"
  | "catalog_lag_repaired"
  | "flush_redriven"
  | "recovery_snapshot"
  | "recovery_gated"
  | "recovery_held"
  | "recovery_healed"
  | "recovery_failed";

export interface EntityReconcileReport {
  entityId: string;
  drift: DriftClass;
  action: RepairAction;
}

export type ReconcilerTickResult =
  | {
      fired: true;
      checked: number;
      reports: EntityReconcileReport[];
      cursor: string;
      wrapped: boolean;
      nextFireAt: number;
    }
  | { fired: false; reason: "stale-generation" | "no-spec" };

export interface StartResult {
  generation: number;
  nextFireAt: number;
}

export interface StopResult {
  generation: number;
  wasRunning: boolean;
}

// ---------------------------------------------------------------------------
// Alert seam (0001:T8.2 wires it to metrics/paging; default logs)
// ---------------------------------------------------------------------------

export interface ReconcilerAlert {
  kind: "unrecoverable_drift";
  entityId: string;
  /** Entity type (addressing §2) — the low-cardinality metric dimension (0001:T8.2). */
  entityType?: string;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * Structured alert hook. A seam so 0001:T8.2 (observability) can route these to
 * metrics/paging; the reconciler only requires it never throws (a throwing
 * sink must not break the tick — the caller guards it anyway).
 */
export interface AlertSink {
  fire(alert: ReconcilerAlert): void;
}

/** Default alert sink: a structured `console.warn`. Prefer `createReconcilerAlertSink` in a deployment. */
export function createConsoleAlertSink(): AlertSink {
  return {
    fire(alert): void {
      console.warn(
        `[reconciler] ${alert.kind} ${alert.entityId}: ${alert.message}`,
        alert.detail ?? {},
      );
    },
  };
}

/**
 * The production alert sink (0002:T2.2). An unrecoverable-drift alert is the
 * single signal that a projection has drifted beyond in-order-replay repair, so
 * this is the ONE fan-out point for it:
 *
 *  1. **Metrics** — bumps the 0001:T8.2 `projection_unrecoverable_drift` counter
 *     (`recordDrift`), tagged by `entity.type` (never the high-cardinality
 *     entity id). The reconciler no longer records this counter inline; the
 *     alert owns it, so the metric and the operator log can never disagree.
 *  2. **Operator log** — a WARN-level structured line an on-call human actually
 *     sees (default `console.warn`; inject `logger` to route to the deployment's
 *     logging pipeline / pager).
 *
 * Never throws (a throwing sink must not break a tick; the reconciler guards it
 * regardless). `metrics` defaults to the no-op recorder so a log-only
 * deployment still works.
 */
export interface ReconcilerAlertSinkOptions {
  /** 0001:T8.2 metrics recorder; drift is counted here. Default no-op. */
  metrics?: CoordinationMetrics;
  /** Operator log line. Default `console.warn`. */
  logger?: (line: string, detail: Record<string, unknown>) => void;
}

export function createReconcilerAlertSink(opts: ReconcilerAlertSinkOptions = {}): AlertSink {
  const metrics = opts.metrics ?? NOOP_COORDINATION_METRICS;
  const logger =
    opts.logger ?? ((line, detail) => console.warn(line, detail));
  return {
    fire(alert): void {
      if (alert.kind === "unrecoverable_drift") {
        metrics.recordDrift(
          alert.entityType !== undefined ? { entityType: alert.entityType } : {},
        );
      }
      logger(
        `[reconciler] ${alert.kind} ${alert.entityId}: ${alert.message}`,
        alert.detail ?? {},
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime context (structural subset of restate.ObjectContext — cron.ts pattern
// + genericCall for cross-object probe/repair)
// ---------------------------------------------------------------------------

export interface ReconcilerRuntimeCtx {
  readonly key: string;
  get<T>(name: string): Promise<T | null>;
  set<T>(name: string, value: T): void;
  clear(name: string): void;
  run<T>(name: string, action: () => T | Promise<T>): Promise<T>;
  genericSend(call: {
    service: string;
    method: string;
    key?: string;
    parameter: unknown;
    delay?: number;
  }): void;
  /**
   * Request-response call to another object handler (the agent-object probe /
   * flush / recovery handlers). JSON-serded. Only the REAL seam impls use it;
   * the reconcile LOGIC never calls it directly (it goes through the seams),
   * so fakes may leave it unimplemented.
   */
  genericCall<Res>(call: {
    service: string;
    method: string;
    key?: string;
    parameter: unknown;
    idempotencyKey?: string;
  }): Promise<Res>;
}

// ---------------------------------------------------------------------------
// Repair seams onto the agent object (real wiring is main's — see header)
// ---------------------------------------------------------------------------

/** Samples a bounded, url-ordered batch of catalog entities past a cursor. */
export interface CatalogSampler {
  /**
   * Return up to `batchSize` entities with `url > cursor` (and matching
   * `tenant` when given), ordered ascending by url. Fewer than `batchSize`
   * rows ⇒ the end of the url space was reached (the caller wraps the cursor).
   * Journaled via `ctx.run` (0001:D1: catalog reads from inside handlers).
   */
  sample(
    ctx: ReconcilerRuntimeCtx,
    opts: { cursor: string; batchSize: number; tenant?: string },
  ): Promise<EntitySample[]>;
}

/**
 * The seam onto an agent object for reconciliation. The real wiring
 * (0002:T2.1) maps these to the agent-object handlers keyed by the entity url
 * (`agentTargetOf`); handler logic lives in projection-outbox.ts:
 *
 * - `probe`   → the SHARED `reconcileProbe` handler (`handleReconcileProbe`)
 *   returning `EntityProbe` from the entity K/V (`outboxConfirmedSeq` +
 *   pending outbox). Shared = safe against a busy exclusive wake (SPIKE §a),
 *   and cheap (a handful of K/V gets, no `ctx.run`, no stream I/O).
 * - `driveFlush` → the EXCLUSIVE `reconcileFlush` handler
 *   (`handleReconcileFlush`): calls `outbox.flush(ctx, url)` and maps
 *   `OutboxDriftError` to `{ kind:'drift' }` (never rethrows — the
 *   reconciler decides the recovery response).
 * - `driveRecovery` → the EXCLUSIVE `reconcileRecovery` handler
 *   (`handleReconcileRecovery`): stages+flushes a
 *   `state_snapshot(reason:'recovery', historyHole:true)` (0001:A1/0001:A7: only the
 *   agent object, the seq allocator, may emit it) and — when `resetEpoch` —
 *   performs the 0001:A9 affine-offset epoch reset, after re-verifying the
 *   drift with a live flush inside its own single-writer invocation.
 */
export interface EntityReconcileClient {
  probe(ctx: ReconcilerRuntimeCtx, entityId: string): Promise<EntityProbe | null>;
  driveFlush(ctx: ReconcilerRuntimeCtx, entityId: string): Promise<FlushDriveOutcome>;
  /**
   * Ask the agent object to execute the 0001:A9 recovery. Returns the agent
   * object's actual `ReconcileRecoveryResult` (0002:T2.1) — `performed:true` for
   * a reset that ran, or `performed:false` with a reason
   * (`gated`/`healthy`/`stream-closed`/`no-live-state`/`failed`) — so the
   * reconciler records the ACCURATE per-entity action instead of assuming the
   * request was carried out (0002:T2.2 fix of the closed-stream cosmetic).
   */
  driveRecovery(
    ctx: ReconcilerRuntimeCtx,
    entityId: string,
    opts: { reason: string; resetEpoch: boolean },
  ): Promise<ReconcileRecoveryResult>;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
  sampler: CatalogSampler;
  client: EntityReconcileClient;
  /** Monotonic GREATEST head_seq upsert (reuse of the 0001:T2.2 catalog writer). */
  catalog: OutboxCatalog;
  alert: AlertSink;
  /**
   * Observability recorder (0001:T8.2). Default no-op. The reconciler is the
   * FLEET-WIDE sampler (0001:A9): on each probed entity it records `outbox_depth`
   * (pending count) and `projection_lag` (catalog head_seq vs
   * `outboxConfirmedSeq`, 0001:A6). The `unrecoverable`-drift counter
   * (`recordDrift`) is NOT recorded here as of 0002:T2.2 — it is owned by the
   * `AlertSink` (`createReconcilerAlertSink`) so the metric and the operator
   * log fan out from one place and can never disagree. Injected so it
   * unit-tests against a fake meter.
   *
   * Gauge-semantics note: these are per-entity SAMPLES tagged only by
   * `entity.type` (never the high-cardinality entity id), so a synchronous
   * gauge's last-value-wins collapses same-type entities within one collection
   * cycle. That is acceptable for a round-robin fleet sampler feeding a
   * rate/heatmap dashboard; a per-entity time series would need an
   * ObservableGauge over a shared resident-entity registry the isolated
   * virtual objects do not hold — an open item for 0001:T9.1/dashboards.
   */
  metrics?: CoordinationMetrics;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Classify projection drift for one entity from the cheap reads (0001:A6#4) — no
 * stream scan. Precedence: a non-empty pending outbox (`stuck_outbox`) is the
 * more urgent condition and is checked first, because re-driving its flush
 * also advances `confirmedSeq` and re-upserts the catalog, subsuming any
 * catalog lag. `unrecoverable` is NOT decided here — it is discovered only
 * when the stuck-outbox flush actually surfaces `OutboxDriftError` (a live
 * outcome, not something the cheap reads can foresee).
 */
export function classifyDrift(input: {
  catalogHeadSeq: number | null;
  confirmedSeq: number | null;
  pendingCount: number;
}): DriftClass {
  if (input.pendingCount > 0) return "stuck_outbox";
  if (input.confirmedSeq === null) return "none";
  if (input.catalogHeadSeq === null || input.catalogHeadSeq < input.confirmedSeq) {
    return "catalog_lag";
  }
  return "none";
}

/**
 * Compute the next round-robin cursor from a sampled page. A full page
 * (`rows.length === batchSize`) advances the cursor to the last url; a short
 * page (including empty) means the url space was exhausted, so the cursor
 * WRAPS to `""` and the next tick restarts from the beginning. Pure.
 */
export function computeNextCursor(
  rows: readonly EntitySample[],
  batchSize: number,
): { nextCursor: string; wrapped: boolean } {
  if (rows.length < batchSize) return { nextCursor: "", wrapped: true };
  return { nextCursor: rows[rows.length - 1]!.url, wrapped: false };
}

/**
 * Map the agent object's `ReconcileRecoveryResult` (0002:T2.1) to the accurate
 * per-entity `RepairAction`. Pure. This is the 0002:T2.2 fix of T2.1's
 * cosmetic follow-up: a held closed stream (`performed:false,
 * reason:"stream-closed"`) is recorded as `recovery_held`, not a misleading
 * `recovery_snapshot` — nothing was written, so nothing is claimed.
 */
export function recoveryActionFor(result: ReconcileRecoveryResult): RepairAction {
  if (result.performed) return "recovery_snapshot";
  switch (result.reason) {
    case "gated":
      return "recovery_gated";
    case "stream-closed":
      return "recovery_held";
    case "healthy":
      return "recovery_healed";
    case "failed":
      return "recovery_failed";
    case "no-live-state":
      // The entity vanished (archived / never spawned) between the probe and the
      // recovery handler — same as an absent probe.
      return "skipped_absent";
    default: {
      const exhaustive: never = result.reason;
      throw new Error(`unknown recovery reason ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-entity reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile ONE sampled entity: probe (cheap K/V read), classify, repair.
 * Returns a report; never throws for an ordinary drift condition (drift is the
 * reconciler's JOB, not an error). A truly unexpected transport failure inside
 * a seam call propagates and Restate retries the tick (idempotent — every
 * repair is monotonic/idempotent).
 */
export async function reconcileEntity(
  ctx: ReconcilerRuntimeCtx,
  deps: ReconcilerDeps,
  sample: EntitySample,
  spec: ReconcilerSpec,
): Promise<EntityReconcileReport> {
  const entityId = sample.url;

  // Archived entities have their K/V cleared (0001:D7/0001:T8.1); nothing to reconcile —
  // the catalog row is the archive-of-record. Skip without a probe.
  if (sample.status === "archived") {
    return { entityId, drift: "none", action: "skipped_archived" };
  }

  const probe = await deps.client.probe(ctx, entityId);
  if (probe === null || probe.status === "archived") {
    // Not resident in Restate (never spawned into K/V, or archived between the
    // catalog sample and the probe). Nothing to do.
    return { entityId, drift: "none", action: "skipped_absent" };
  }

  // 0001:T8.2 fleet sampling (0001:A9): record outbox depth + projection lag for every
  // resident entity this tick, before repair (the pre-repair snapshot is what
  // a lag/backlog dashboard wants).
  const metrics = deps.metrics ?? NOOP_COORDINATION_METRICS;
  const lag = Math.max(0, (probe.confirmedSeq ?? -1) - (sample.headSeq ?? -1));
  metrics.recordOutboxDepth(probe.pendingCount, { entityType: sample.type });
  metrics.recordProjectionLag(lag, { entityType: sample.type });

  const drift = classifyDrift({
    catalogHeadSeq: sample.headSeq,
    confirmedSeq: probe.confirmedSeq,
    pendingCount: probe.pendingCount,
  });

  switch (drift) {
    case "none":
      // The cheap path: one catalog read + one K/V probe, zero stream I/O.
      return { entityId, drift, action: "ok" };

    case "catalog_lag": {
      // head_seq < confirmedSeq (0001:A6#5 floor / lost upsert). Re-drive the
      // monotonic GREATEST head_seq upsert to the true confirmed value.
      const headSeq = probe.confirmedSeq!;
      await ctx.run("reconcile-catalog-head", () =>
        deps.catalog.upsertHead({ entityId, headSeq, status: probe.status }),
      );
      return { entityId, drift, action: "catalog_lag_repaired" };
    }

    case "stuck_outbox": {
      const outcome = await deps.client.driveFlush(ctx, entityId);
      if (outcome.kind === "flushed") {
        return { entityId, drift, action: "flush_redriven" };
      }
      // Unrecoverable: in-order replay can't fix it (0001:D3 catastrophic path).
      // Always ALERT (0001:T8.2 seam) — the sink fans the alert out to the drift
      // metric AND an operator log (0002:T2.2). Then request a recovery
      // snapshot; whether the agent object is ALLOWED to bump the epoch
      // (0001:A6#6) is gated by the spec.
      deps.alert.fire({
        kind: "unrecoverable_drift",
        entityId,
        entityType: sample.type,
        message: outcome.message,
        detail: {
          pendingFirstSeq: probe.pendingFirstSeq,
          pendingLastSeq: probe.pendingLastSeq,
          catalogHeadSeq: sample.headSeq,
          confirmedSeq: probe.confirmedSeq,
        },
      });
      const resetEpoch = spec.allowEpochReset === true;
      const recovery = await deps.client.driveRecovery(ctx, entityId, {
        reason: outcome.message,
        resetEpoch,
      });
      return { entityId, drift, action: recoveryActionFor(recovery) };
    }

    default: {
      const exhaustive: never = drift;
      throw new Error(`unknown drift class ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Handler logic (start / stop / tick) — cron.ts generation-guard discipline
// ---------------------------------------------------------------------------

async function currentGeneration(ctx: ReconcilerRuntimeCtx): Promise<number> {
  return (await ctx.get<number>(RECON_KV.generation)) ?? 0;
}

function sendTick(
  ctx: ReconcilerRuntimeCtx,
  generation: number,
  scheduledFor: number,
  delayMs: number,
): void {
  const msg: TickMessage = { generation, scheduledFor };
  ctx.genericSend({
    service: RECONCILER_SERVICE_NAME,
    method: "tick",
    key: ctx.key,
    parameter: msg,
    delay: Math.max(0, delayMs),
  });
}

function assertValidSpec(spec: ReconcilerSpec): void {
  if (!(spec.intervalMs > 0)) {
    throw new restate.TerminalError(`reconciler intervalMs must be > 0, got ${spec.intervalMs}`);
  }
  if (!(spec.batchSize >= 1) || !Number.isInteger(spec.batchSize)) {
    throw new restate.TerminalError(`reconciler batchSize must be an integer >= 1, got ${spec.batchSize}`);
  }
}

/**
 * Start (or replace) the reconciliation loop. Bumps the generation FIRST
 * (atomically with storing the new spec — this invalidates any prior tick
 * chain), then issues one delayed self-send of `tick()`.
 */
export async function handleStart(
  ctx: ReconcilerRuntimeCtx,
  spec: ReconcilerSpec = DEFAULT_RECONCILER_SPEC,
): Promise<StartResult> {
  assertValidSpec(spec);
  const generation = (await currentGeneration(ctx)) + 1;
  ctx.set(RECON_KV.generation, generation);
  ctx.set(RECON_KV.spec, spec);

  const now = await ctx.run("now", () => Date.now());
  const nextFireAt = now + spec.intervalMs;
  sendTick(ctx, generation, nextFireAt, spec.intervalMs);

  return { generation, nextFireAt };
}

/** Stop the loop: bump generation + clear spec atomically (kills the tick chain). */
export async function handleStop(ctx: ReconcilerRuntimeCtx): Promise<StopResult> {
  const spec = await ctx.get<ReconcilerSpec>(RECON_KV.spec);
  const generation = (await currentGeneration(ctx)) + 1;
  ctx.set(RECON_KV.generation, generation);
  ctx.clear(RECON_KV.spec);
  return { generation, wasRunning: spec !== null };
}

/**
 * One reconciliation tick. Generation-guarded (a stale tick from a superseded
 * chain is a pure no-op — no work, no reschedule). Samples a batch from the
 * catalog cursor, reconciles each entity, advances + wraps the cursor, and
 * issues the next delayed self-send.
 */
export async function handleReconcileTick(
  ctx: ReconcilerRuntimeCtx,
  deps: ReconcilerDeps,
  msg: TickMessage,
): Promise<ReconcilerTickResult> {
  const generation = await currentGeneration(ctx);
  if (msg.generation !== generation) {
    return { fired: false, reason: "stale-generation" };
  }
  const spec = await ctx.get<ReconcilerSpec>(RECON_KV.spec);
  if (!spec) {
    // Defensive: generation match with no spec is unreachable (stop() bumps
    // generation atomically with clearing spec). Treat as stale.
    return { fired: false, reason: "no-spec" };
  }

  const cursor = (await ctx.get<string>(RECON_KV.cursor)) ?? "";
  const rows = await deps.sampler.sample(ctx, {
    cursor,
    batchSize: spec.batchSize,
    ...(spec.tenant !== undefined && { tenant: spec.tenant }),
  });

  const reports: EntityReconcileReport[] = [];
  for (const sample of rows) {
    reports.push(await reconcileEntity(ctx, deps, sample, spec));
  }

  // Advance / wrap the round-robin cursor, then persist it.
  const { nextCursor, wrapped } = computeNextCursor(rows, spec.batchSize);
  ctx.set(RECON_KV.cursor, nextCursor);

  // Reschedule the next tick (same generation) and record the tick time.
  const now = await ctx.run("now", () => Date.now());
  ctx.set(RECON_KV.lastTickAt, now);
  const nextFireAt = now + spec.intervalMs;
  sendTick(ctx, msg.generation, nextFireAt, spec.intervalMs);

  return { fired: true, checked: rows.length, reports, cursor: nextCursor, wrapped, nextFireAt };
}

// ---------------------------------------------------------------------------
// Real seam implementations
// ---------------------------------------------------------------------------

/**
 * Real `CatalogSampler` over the Drizzle catalog (`@teaspill/catalog`). Reads
 * the cheap columns only (url/type/status/head_seq), url-ordered, past the
 * cursor. Journaled through `ctx.run` (0001:D1: catalog reads from inside handlers)
 * so a retried tick samples the SAME page and repairs identically.
 */
export function createDrizzleCatalogSampler(db: CatalogDb): CatalogSampler {
  return {
    async sample(ctx, { cursor, batchSize, tenant }): Promise<EntitySample[]> {
      return ctx.run("reconcile-sample", async () => {
        const filters: SQL[] = [];
        // `url > cursor` (cursor "" ⇒ all urls, the wrap-around start).
        if (cursor !== "") filters.push(gt(entities.url, cursor));
        if (tenant !== undefined) filters.push(eq(entities.tenant, tenant));
        const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
        const rows = await db
          .select({
            url: entities.url,
            type: entities.type,
            status: entities.status,
            headSeq: entities.headSeq,
          })
          .from(entities)
          .where(where)
          .orderBy(asc(entities.url))
          .limit(batchSize);
        return rows.map((r) => ({
          url: r.url,
          type: r.type,
          status: r.status as EntityStatus,
          headSeq: r.headSeq,
        }));
      });
    },
  };
}

/**
 * Real `EntityReconcileClient` over Restate cross-object calls. Targets the
 * agent object (`agent.<type>` / key `<id>`, via `agentTargetOf`) with the
 * reconcile handlers agent.ts wires since 0002:T2.1 (`reconcileProbe` shared,
 * `reconcileFlush`/`reconcileRecovery` exclusive — see `EntityReconcileClient`
 * doc). JSON-serded generic calls. Live scheduling of the reconciler loop
 * against these handlers is 0002:T2.2; the handler↔logic round trip is covered
 * end-to-end (over fakes) in projection-outbox.test.ts.
 */
export function createRestateEntityReconcileClient(opts?: {
  probeHandler?: string;
  flushHandler?: string;
  recoveryHandler?: string;
}): EntityReconcileClient {
  const probeHandler = opts?.probeHandler ?? "reconcileProbe";
  const flushHandler = opts?.flushHandler ?? "reconcileFlush";
  const recoveryHandler = opts?.recoveryHandler ?? "reconcileRecovery";
  return {
    async probe(ctx, entityId): Promise<EntityProbe | null> {
      const target = agentTargetOf(entityId);
      return ctx.genericCall<EntityProbe | null>({
        service: target.service,
        method: probeHandler,
        key: target.key,
        parameter: {},
      });
    },
    async driveFlush(ctx, entityId): Promise<FlushDriveOutcome> {
      const target = agentTargetOf(entityId);
      return ctx.genericCall<FlushDriveOutcome>({
        service: target.service,
        method: flushHandler,
        key: target.key,
        parameter: {},
      });
    },
    async driveRecovery(ctx, entityId, driveOpts): Promise<ReconcileRecoveryResult> {
      const target = agentTargetOf(entityId);
      return ctx.genericCall<ReconcileRecoveryResult>({
        service: target.service,
        method: recoveryHandler,
        key: target.key,
        parameter: driveOpts,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduling the loop from a real bootstrap (0002:T2.2)
//
// `createReconcilerObject` only BINDS the handlers; nothing starts ticking
// until `reconciler/<partition>/start` is invoked once. Exactly like cron
// (cron.ts: nothing self-schedules — a caller invokes `schedule()`), the
// reconciler is kicked from the deployment that owns it: the D4 agent-loop
// service (0001:D4) that binds the reconciler object via
// `createCoordinationEndpoint({ reconciler })`, right after it has served the
// endpoint and registered the deployment. `scheduleReconcilers` is that hook —
// a "compose-adjacent bootstrap" the reference deployment (0002:T4.1) calls.
//
// SAFE RE-RUN (the cron generation-guard): every `start` bumps the object's
// generation atomically with storing the spec (handleStart), so re-running this
// on a redeploy / restart supersedes the prior tick chain — the old chain's
// in-flight delayed `tick` is a pure no-op (stale generation). No de-dup or
// "already scheduled?" check is needed here; kicking `start` on every boot is
// idempotent-by-supersession.
//
// UNIT-TEST DISCIPLINE: scheduling NEVER happens implicitly (no import-time /
// object-construction side effect — `createReconcilerObject` is inert). On top
// of that, `scheduleReconcilers` requires an explicit `enabled: true` opt-in
// and is a logged no-op otherwise, so a deployment wired for tests (or a bring-
// up that has not opted in) can construct + bind the object without ever
// starting a live loop.
// ---------------------------------------------------------------------------

/** The subset of the reconciler object's ingress surface the bootstrap drives. */
export interface ReconcilerScheduleClient {
  start(partition: string, spec: ReconcilerSpec): Promise<StartResult>;
  stop(partition: string): Promise<StopResult>;
}

export interface HttpReconcilerScheduleClientOptions {
  /** Restate ingress base url, e.g. `http://restate:8080` (same transport as `createHttpSteerSource`). */
  ingressUrl: string;
  fetch?: typeof fetch;
  /** Extra headers (e.g. auth) merged into each request. */
  headers?: Record<string, string>;
}

/**
 * Real `ReconcilerScheduleClient` over Restate ingress HTTP —
 * `POST /reconciler/<partition>/{start,stop}` with a JSON body. The partition
 * key is percent-encoded in the path (0001:A4 f-2: arbitrary-string keys must be
 * encoded in raw ingress paths; the SDK's typed clients do this, this hand-
 * rolled transport must too). Mirrors `createHttpSteerSource` (steer.ts).
 */
export function createHttpReconcilerScheduleClient(
  opts: HttpReconcilerScheduleClientOptions,
): ReconcilerScheduleClient {
  const base = opts.ingressUrl.replace(/\/$/, "");
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function call<Res>(partition: string, handler: string, body: unknown): Promise<Res> {
    const path = `/${RECONCILER_SERVICE_NAME}/${encodeURIComponent(partition)}/${handler}`;
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { ...opts.headers, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `reconciler ${handler} for partition ${JSON.stringify(partition)} failed: ${res.status} ${detail}`,
      );
    }
    return (await res.json()) as Res;
  }

  return {
    start: (partition, spec) => call<StartResult>(partition, "start", spec),
    stop: (partition) => call<StopResult>(partition, "stop", {}),
  };
}

export interface ScheduleReconcilersOptions {
  client: ReconcilerScheduleClient;
  /**
   * Explicit opt-in. Scheduling is a NO-OP unless this is true — the
   * unit-test / not-opted-in guard (see section header). Wire it from a
   * deployment env (e.g. `TEASPILL_RECONCILER !== "off"`), never default-on in
   * a shared library path.
   */
  enabled: boolean;
  /** Partition keys to start (0001:D2: one independent tick chain per key). Default `["default"]`. */
  partitions?: readonly string[];
  /** Loop config for every partition. Default `DEFAULT_RECONCILER_SPEC`. */
  spec?: ReconcilerSpec;
  /** Operator log line. Default `console.error` (stderr, like `teaspill dev`). */
  logger?: (line: string) => void;
}

export interface ScheduledReconciler {
  partition: string;
  generation: number;
  nextFireAt: number;
}

/**
 * Start (or supersede) the reconciler loop for each partition from a real
 * deployment bootstrap. Idempotent by supersession (see section header). A
 * logged no-op when `enabled` is false. Returns what was scheduled (empty when
 * disabled) so a caller can assert/report it.
 */
export async function scheduleReconcilers(
  opts: ScheduleReconcilersOptions,
): Promise<{ scheduled: ScheduledReconciler[] }> {
  const log = opts.logger ?? ((line: string) => console.error(line));
  const partitions = opts.partitions ?? [DEFAULT_RECONCILER_PARTITION];
  const spec = opts.spec ?? DEFAULT_RECONCILER_SPEC;

  if (!opts.enabled) {
    log(`[reconciler] scheduling disabled (opt-in with enabled:true) — ${partitions.length} partition(s) not started`);
    return { scheduled: [] };
  }

  const scheduled: ScheduledReconciler[] = [];
  for (const partition of partitions) {
    const result = await opts.client.start(partition, spec);
    scheduled.push({ partition, generation: result.generation, nextFireAt: result.nextFireAt });
    log(
      `[reconciler] scheduled partition ${JSON.stringify(partition)} ` +
        `(generation ${result.generation}, interval ${spec.intervalMs}ms, batch ${spec.batchSize})`,
    );
  }
  return { scheduled };
}

// ---------------------------------------------------------------------------
// Restate wiring — thin adapter from ObjectContext to ReconcilerRuntimeCtx.
// ---------------------------------------------------------------------------

function adapt(ctx: restate.ObjectContext): ReconcilerRuntimeCtx {
  return {
    key: ctx.key,
    get: <T>(name: string) => ctx.get<T>(name),
    set: <T>(name: string, value: T) => {
      ctx.set<T>(name, value);
    },
    clear: (name: string) => {
      ctx.clear(name);
    },
    run: <T>(name: string, action: () => T | Promise<T>) => ctx.run<T>(name, async () => action()),
    genericSend: (call) => {
      ctx.genericSend(call);
    },
    genericCall: <Res>(call: {
      service: string;
      method: string;
      key?: string;
      parameter: unknown;
      idempotencyKey?: string;
    }) =>
      ctx.genericCall<unknown, Res>({
        service: call.service,
        method: call.method,
        ...(call.key !== undefined && { key: call.key }),
        parameter: call.parameter,
        inputSerde: serde.json as restate.Serde<unknown>,
        outputSerde: serde.json as restate.Serde<Res>,
        ...(call.idempotencyKey !== undefined && { idempotencyKey: call.idempotencyKey }),
      }) as unknown as Promise<Res>,
  };
}

export interface ReconcilerObjectConfig {
  deps: ReconcilerDeps;
}

/**
 * Build the `reconciler/<partition>` virtual object. Handlers are short
 * (K/V + one delayed self-send + a bounded batch of journaled reads/repairs),
 * so — like cron.ts, and unlike the agent object (0001:A4) — they stay exclusive
 * (default) with no `explicitCancellation`: there is no long-running `ctx.run`
 * for an interrupt to race, and the loop is stopped by the generation guard,
 * not by aborting an in-flight tick.
 */
export function createReconcilerObject(config: ReconcilerObjectConfig) {
  return restate.object({
    name: RECONCILER_SERVICE_NAME,
    handlers: {
      start: async (ctx: restate.ObjectContext, spec?: ReconcilerSpec): Promise<StartResult> =>
        handleStart(adapt(ctx), spec ?? DEFAULT_RECONCILER_SPEC),
      stop: async (ctx: restate.ObjectContext): Promise<StopResult> => handleStop(adapt(ctx)),
      tick: async (ctx: restate.ObjectContext, msg: TickMessage): Promise<ReconcilerTickResult> =>
        handleReconcileTick(adapt(ctx), config.deps, msg),
    },
  });
}

export type ReconcilerObject = ReturnType<typeof createReconcilerObject>;
