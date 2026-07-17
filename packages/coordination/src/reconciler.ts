/**
 * `reconciler/<partition>` — T5.3: the drift reconciler + repair loop (D3).
 *
 * A cron-style self-rescheduling Restate virtual object (same generation-guard
 * discipline as `cron.ts`) that periodically SAMPLES a bounded batch of
 * catalog entities and, for each, compares the catalog's `head_seq` against
 * the entity's own last-confirmed seq to detect and repair projection drift
 * (D3 / DECISIONS A6). It is the counterpart to the outbox (T2.2): the outbox
 * keeps a single entity's projection exactly-once on the hot path; the
 * reconciler is the periodic backstop that heals the residue the crash matrix
 * documents (catalog lag, stuck outbox, catastrophic stream loss).
 *
 * ## The cheap confirmed-seq read (A6#4 — no stream scan)
 *
 * PLAN T5.3 anticipates: reading a stream's tail seq is expensive (a scan);
 * instead the outbox tracks `outboxConfirmedSeq` in the entity's K/V at trim
 * time (DECISIONS A6#4). The reconciler reads THAT — via a cheap shared-read
 * probe on the agent object — never the stream. So a no-drift tick costs one
 * catalog batch read + one K/V probe per entity and zero stream I/O.
 *
 * ## Two sources, one comparison
 *
 * - Catalog `entities.head_seq` (Postgres, sampled in a batch): the last
 *   CONFIRMED seq the projection upserted. DECISIONS A6#5: this is a FLOOR,
 *   not exact — a crash between the outbox trim and the catalog upsert leaves
 *   it lagging the entity's true `outboxConfirmedSeq` by one flush.
 * - Entity K/V `outboxConfirmedSeq` + pending-outbox depth (the probe): the
 *   ground truth for what the entity has actually confirmed / still owes.
 *
 * ## The three drift classes + repairs (PLAN T5.3)
 *
 * 1. **`catalog_lag`** — `head_seq < confirmedSeq` (the A6#5 floor case, or a
 *    lost catalog upsert). Repair: re-drive the catalog `head_seq` upsert to
 *    `confirmedSeq` (idempotent, monotonic GREATEST — `projection-catalog.ts`).
 *    Cheap; no stream contact.
 * 2. **`stuck_outbox`** — the entity's pending outbox is non-empty (events
 *    staged but not confirmed onto the stream — a wake that crashed before its
 *    opening flush completed, or an entity that went idle mid-flush). Repair:
 *    re-drive the entity's outbox `flush` (idempotent per T2.2 — in-order
 *    replay from the first unconfirmed, duplicates dedup). This pushes the
 *    stuck events and advances both `confirmedSeq` and the catalog.
 * 3. **`unrecoverable`** — a `stuck_outbox` whose flush cannot make progress:
 *    the flush surfaces `OutboxDriftError` (producer seq gap below the first
 *    unconfirmed ⇒ stream genuinely lost / rolled back; fenced epoch; closed
 *    stream — none fixable by in-order replay). Repair (D3 catastrophic path):
 *    ask the entity to emit a `state_snapshot(reason:'recovery',
 *    historyHole:true)` and CONTINUE, and fire a structured ALERT (the
 *    `AlertSink` seam T8.2 wires to metrics/paging). See "history hole" below.
 *
 * ## History-hole marker (PLAN "history_hole marker event")
 *
 * PLAN T5.3 asks for a "history_hole marker event". The FROZEN v1 schema
 * (DECISIONS A5) has no distinct `history_hole` event type; instead the
 * `state_snapshot` payload carries `historyHole: true`
 * (`stateSnapshotPayloadSchema`, events.ts). We represent the hole THAT way —
 * the recovery snapshot is itself the marker: a complete state as of its own
 * seq, flagged so consumers (T5.2 fast-join `selectFastJoinSnapshot`,
 * `checkSeqContiguity`) know not to gap-check across it. No new event type is
 * introduced; this stays additive-only under the freeze. (If a deployment
 * later wants a distinct machine signal, it rides `opaque` — but v1 does not.)
 *
 * ## A6#6 — epoch/offset resolution (this task's to settle)
 *
 * DECISIONS A6#6 left open: a producer epoch bump/reset breaks the
 * `Producer-Seq == canonical seq` identity (A1) and would need a per-producer
 * offset. Resolution (v1):
 *
 * - The reconciler's AUTOMATIC repairs — `catalog_lag` (a pure catalog write)
 *   and `stuck_outbox` (in-order flush REPLAY at the *existing* epoch) — NEVER
 *   bump the epoch. `Producer-Seq == seq` holds throughout. For these paths,
 *   A6#6 is a documented non-issue.
 * - The catastrophic reset (writing a recovery snapshot onto a genuinely-lost
 *   stream, where in-order replay can't proceed) is the only path that would
 *   need a new epoch. The mechanism is DESIGNED here so the identity survives:
 *   generalize the mapping to the affine `Producer-Seq = canonicalSeq -
 *   producerSeqOffset` and persist `outboxProducerSeqOffset` in the entity K/V
 *   beside `outboxProducerEpoch`. Normal operation is offset 0, epoch 0 ⇒
 *   `Producer-Seq == seq` (A1 unchanged). A reset at canonical seq N sets
 *   `epoch = E+1` and `offset = N`: the recovery `state_snapshot` appends at
 *   `Producer-Seq 0` under the new epoch (satisfying the server's "a new epoch
 *   must start at seq 0" rule), while its canonical `seq` stays N (gapless
 *   continuation, A1 preserved for every reader); subsequent events append at
 *   `Producer-Seq = seq - N`. Readers/dedup/context are entirely
 *   canonical-seq based (A6#2), so epoch+offset are invisible above the
 *   outbox.
 * - v1 SCOPE / where the epoch bump lives: the affine append and the reset
 *   step belong in `projection-outbox.ts` + the agent object (both OFF-LIMITS
 *   to this task — the reconciler owns detection + orchestration, not the
 *   entity's own K/V). So the reconciler DETECTS the unrecoverable condition,
 *   requests recovery through the agent-object seam, and ALERTS; the actual
 *   epoch-bumping append is MAIN's follow-up (see the WORKLOG note + proposed
 *   DECISIONS amendment). Until that lands, the recovery request on a
 *   genuinely-lost stream would itself surface `OutboxDriftError`, so the
 *   destructive reset is GATED (`allowEpochReset`, default false) exactly like
 *   the A8 idle-auto-archive default-off pattern — v1 alerts + marks the hole
 *   and stays non-destructive.
 *
 * ## Sampling / cursor (round-robin, oldest-checked-first)
 *
 * The reconciler keeps its OWN cursor in K/V (`RECON_KV.cursor`, a url
 * high-water mark). Each tick samples `WHERE url > cursor ORDER BY url LIMIT
 * batchSize`; a short page means the end was reached, so the cursor WRAPS to
 * `""` (which is `< ` every url) and the next tick starts from the beginning.
 * Over successive ticks every entity is visited round-robin; there is no
 * per-row "last checked" column to maintain (keeping catalog writes to the
 * repair path only, D1). Cadence is `intervalMs` between ticks (default 60s),
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
 *   round trip — is a live conformance item (T6.3) and a chaos target (T9.1),
 *   exactly as SPIKE-RESTATE.md prescribes.
 */

import * as restate from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk";
import { eq, and, gt, asc, type SQL } from "drizzle-orm";
import { entities, type CatalogDb } from "@teaspill/catalog";
import type { EntityStatus } from "./agent-runtime.js";
import { agentTargetOf } from "./agent-seams.js";
import type { OutboxCatalog } from "./projection-outbox.js";

/** Restate service name for the reconciler object (docs/addressing.md style; see cron.ts). */
export const RECONCILER_SERVICE_NAME = "reconciler";

/**
 * Default partition key when a deployment runs a single reconciler. Multiple
 * partitions (e.g. one per tenant) are just distinct keys — each owns an
 * independent cursor + tick chain, so they never contend (single-writer per
 * key, D2).
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
   * Gate for the destructive catastrophic reset (A6#6 epoch bump). Default
   * false: on `unrecoverable` drift the reconciler ALERTS + requests a
   * recovery snapshot but does NOT authorize an epoch reset (the affine-offset
   * append is main's follow-up; see module header). Set true only once that
   * append path exists and ops opts in. Mirrors the A8 idle-auto-archive
   * default-off caution.
   */
  allowEpochReset?: boolean;
}

export const DEFAULT_RECONCILER_SPEC: ReconcilerSpec = {
  intervalMs: 60_000,
  batchSize: 50,
  allowEpochReset: false,
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
  /** `entities.head_seq` — last CONFIRMED seq per the catalog; null ⇒ nothing confirmed yet (A6#5 floor). */
  headSeq: number | null;
}

/** The cheap per-entity K/V read (A6#4): confirmed-seq + pending-outbox depth. No stream scan. */
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

/** What a single entity's reconciliation did this tick. */
export type RepairAction =
  | "ok"
  | "skipped_absent"
  | "skipped_archived"
  | "catalog_lag_repaired"
  | "flush_redriven"
  | "recovery_snapshot"
  | "recovery_gated";

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
// Alert seam (T8.2 wires it to metrics/paging; default logs)
// ---------------------------------------------------------------------------

export interface ReconcilerAlert {
  kind: "unrecoverable_drift";
  entityId: string;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * Structured alert hook. A seam so T8.2 (observability) can route these to
 * metrics/paging; the reconciler only requires it never throws (a throwing
 * sink must not break the tick — the caller guards it anyway).
 */
export interface AlertSink {
  fire(alert: ReconcilerAlert): void;
}

/** Default alert sink: a structured `console.warn`. Replace via T8.2. */
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
   * Journaled via `ctx.run` (D1: catalog reads from inside handlers).
   */
  sample(
    ctx: ReconcilerRuntimeCtx,
    opts: { cursor: string; batchSize: number; tenant?: string },
  ): Promise<EntitySample[]>;
}

/**
 * The seam onto an agent object for reconciliation. Real wiring (main's
 * follow-up) maps these to additive agent-object handlers keyed by the entity
 * url (`agentTargetOf`):
 *
 * - `probe`   → a SHARED read handler returning `EntityProbe` from the entity
 *   K/V (`outboxConfirmedSeq` + pending outbox). Shared = safe against a busy
 *   exclusive wake (SPIKE §a), and cheap (no stream I/O).
 * - `driveFlush` → an EXCLUSIVE handler that calls `outbox.flush(ctx, url)` and
 *   maps `OutboxDriftError` to `{ kind:'drift' }` (never rethrows — the
 *   reconciler decides the recovery response).
 * - `driveRecovery` → an EXCLUSIVE handler that stages+flushes a
 *   `state_snapshot(reason:'recovery', historyHole:true)` (A1/A7: only the
 *   agent object, the seq allocator, may emit it) and — when `resetEpoch` and
 *   the entity's config allow — performs the A6#6 affine-offset epoch reset.
 */
export interface EntityReconcileClient {
  probe(ctx: ReconcilerRuntimeCtx, entityId: string): Promise<EntityProbe | null>;
  driveFlush(ctx: ReconcilerRuntimeCtx, entityId: string): Promise<FlushDriveOutcome>;
  driveRecovery(
    ctx: ReconcilerRuntimeCtx,
    entityId: string,
    opts: { reason: string; resetEpoch: boolean },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
  sampler: CatalogSampler;
  client: EntityReconcileClient;
  /** Monotonic GREATEST head_seq upsert (reuse of the T2.2 catalog writer). */
  catalog: OutboxCatalog;
  alert: AlertSink;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Classify projection drift for one entity from the cheap reads (A6#4) — no
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

  // Archived entities have their K/V cleared (D7/T8.1); nothing to reconcile —
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
      // head_seq < confirmedSeq (A6#5 floor / lost upsert). Re-drive the
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
      // Unrecoverable: in-order replay can't fix it (D3 catastrophic path).
      // Always ALERT (T8.2 seam). Request a recovery snapshot; whether the
      // agent object is ALLOWED to bump the epoch (A6#6) is gated by the spec.
      deps.alert.fire({
        kind: "unrecoverable_drift",
        entityId,
        message: outcome.message,
        detail: {
          pendingFirstSeq: probe.pendingFirstSeq,
          pendingLastSeq: probe.pendingLastSeq,
          catalogHeadSeq: sample.headSeq,
          confirmedSeq: probe.confirmedSeq,
        },
      });
      const resetEpoch = spec.allowEpochReset === true;
      await deps.client.driveRecovery(ctx, entityId, {
        reason: outcome.message,
        resetEpoch,
      });
      return {
        entityId,
        drift,
        action: resetEpoch ? "recovery_snapshot" : "recovery_gated",
      };
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
 * cursor. Journaled through `ctx.run` (D1: catalog reads from inside handlers)
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
 * additive reconcile handlers MAIN must wire (see the `EntityReconcileClient`
 * doc + WORKLOG note). JSON-serded generic calls. Until those handlers exist
 * this cannot run against a live stack — the reconcile LOGIC and its tests use
 * fakes; this factory is the drop-in real seam for T6.3/T9.1 wiring.
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
    async driveRecovery(ctx, entityId, driveOpts): Promise<void> {
      const target = agentTargetOf(entityId);
      await ctx.genericCall<void>({
        service: target.service,
        method: recoveryHandler,
        key: target.key,
        parameter: driveOpts,
      });
    },
  };
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
 * so — like cron.ts, and unlike the agent object (A4) — they stay exclusive
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
