/**
 * Control API — T2.5: the four public lifecycle verbs (D8's minimal control
 * surface — `interrupt`, `pause`, `resume`, `archive` — NOT POSIX signals).
 *
 * These are the typed, public front doors built ON T2.1's interrupt seam
 * (agent.ts `handleSignal` / `runWake`'s `raceInterrupt`) and the D3 outbox
 * (agent-seams.ts `ProjectionOutbox`). Each verb records a `control` event on
 * the timeline (frozen schema, A5) so the lifecycle transition is visible and
 * resumable. Anything a custom `SIGUSR`-style signal would have carried is a
 * plain typed message (D8) — `send`/`message` (T2.3) already covers that; this
 * module deliberately does NOT build a signal vocabulary.
 *
 * ## How each verb sits on the seam
 *
 * - **`interrupt` (SHARED, `handleInterrupt`)** — the ONLY verb that must reach
 *   a BUSY exclusive wake, so it is a shared handler (SPIKE §a: shared handlers
 *   run concurrently with a busy exclusive invocation and can `ctx.cancel` it).
 *   It reads `currentInvocationId` (visible live) and cancels it; the wake's
 *   `raceInterrupt` then aborts the harness (~20 ms, A4) and — because the
 *   object runs `explicitCancellation: true` — durably records
 *   `control(interrupt)` + `run_finished(interrupted)` and stays live. This is
 *   exactly what T2.1's `handleSignal(interrupt)` already does; `handleInterrupt`
 *   is the typed, single-purpose front door to it (the seam CASDK's `interrupt`
 *   maps to later in T7.2). **Reason threading caveat:** a shared handler
 *   cannot write K/V (SPIKE §a), so the free-text `reason` cannot be attached
 *   to the busy run's `control(interrupt)` event by the interrupter; it is
 *   returned to the caller (log/UI) and the wake records the verb only. The
 *   three EXCLUSIVE verbs below hold the single-writer lock and DO record their
 *   reason on the event.
 *
 * - **`pause` / `resume` (EXCLUSIVE)** — status flags cannot be written from a
 *   shared handler, so these are exclusive handlers: they serialize behind any
 *   in-flight wake (single-writer) and take effect at the NEXT invocation
 *   start. `pause` sets the `AGENT_KV.paused` flag (a runtime control flag,
 *   NOT a `status`-enum change — see AGENT_KV.paused); `handleMessage` then
 *   queues wakes into `AGENT_KV.pausedMailbox` without running the harness.
 *   `resume` clears the flag and re-enqueues the mailbox as ordinary `message`
 *   self-sends (processed in order once unpaused).
 *
 * - **`archive` (EXCLUSIVE, `applyArchive`)** — the D7/T8.1 lifecycle end AND
 *   "kill". Records `control(archive)` + `state_snapshot(pre_archive)` +
 *   terminal `archived`, transitions catalog `status=archived` (via the outbox
 *   catalog upsert, which reads `AGENT_KV.status` at flush time), and clears
 *   ALL K/V. Resurrection (rehydrate-from-catalog-snapshot) is deliberately
 *   NOT built here — that is T8.1; a later message to an archived (cleared)
 *   entity still hits `handleMessage`'s "no live state" terminal error until
 *   T8.1 lands the rehydrate path (and flips the T2.3 dead-status default, see
 *   DECISIONS "Note — dead-letter vs resurrection"). The same body backs the
 *   idle self-scheduled `archiveTick` (trigger `idle`) and this verb (trigger
 *   `requested`).
 */

import type { ControlVerb, JsonValue, RunUsage, TimelineEvent, TimelineEventInit } from "@teaspill/schema";
import {
  AGENT_KV,
  ZERO_RUN_USAGE,
  headSeqOf,
  type AgentRuntimeCtx,
  type AgentSharedRuntimeCtx,
  type EntityStatus,
} from "./agent-runtime.js";
import { DEFAULT_OUTBOX_CHUNK_SIZE, commitEventsChunked } from "./agent-seams.js";
import { boundArchiveSnapshotState } from "./archive-snapshot.js";
import { OUTBOX_KV } from "./projection-outbox.js";
import { MESSAGING_KV } from "./messaging.js";
import {
  agentEntityUrl,
  agentServiceName,
  scheduleArchiveTick,
  type AgentMessageInput,
  type AgentObjectConfig,
  type WakeResult,
} from "./agent.js";

const iso = (ms: number): string => new Date(ms).toISOString();

/** Common input to the exclusive verbs (and the interrupt front door). */
export interface ControlInput {
  /** Free-text reason recorded on the `control` event (exclusive verbs) or returned (interrupt). */
  reason?: string;
  /** Requesting principal/entity url, when known. */
  from?: string;
}

// Small per-call resolution of the two config knobs the verbs need, without
// pulling agent.ts's private `resolved()` into the import cycle.
function tenantOf(config: AgentObjectConfig): string {
  return config.tenant ?? "default";
}
function chunkOf(config: AgentObjectConfig): number {
  return config.outboxChunkSize ?? DEFAULT_OUTBOX_CHUNK_SIZE;
}
function entityIdOf(ctx: { key: string }, config: AgentObjectConfig): string {
  return agentEntityUrl(tenantOf(config), config.entityType, ctx.key);
}

// ---------------------------------------------------------------------------
// interrupt (SHARED front door)
// ---------------------------------------------------------------------------

export type InterruptResult =
  | { verb: "interrupt"; delivered: true; cancelledInvocationId: string }
  | { verb: "interrupt"; delivered: false; reason: "idle" };

/**
 * Public `interrupt` verb — the typed front door to T2.1's shared cancel seam.
 * Reads the in-flight `currentInvocationId` (shared handlers see it live,
 * SPIKE §a-2) and `ctx.cancel`s it; the exclusive wake's `raceInterrupt` does
 * the durable rest (control event + run_finished(interrupted), A4). Idle
 * entity ⇒ nothing to interrupt (`delivered: false`). `reason` is echoed only
 * — see the module header's reason-threading caveat.
 */
export async function handleInterrupt(
  ctx: AgentSharedRuntimeCtx,
  _config: AgentObjectConfig,
  _input: ControlInput = {},
): Promise<InterruptResult> {
  const inFlight = await ctx.get<string>(AGENT_KV.currentInvocationId);
  if (!inFlight) return { verb: "interrupt", delivered: false, reason: "idle" };
  // Cancel-of-completed is a harmless server 409 (SPIKE §a-3) — no TOCTOU
  // between the read and the cancel.
  ctx.cancelInvocation(inFlight);
  return { verb: "interrupt", delivered: true, cancelledInvocationId: inFlight };
}

// ---------------------------------------------------------------------------
// pause / resume (EXCLUSIVE — status flags checked at invocation start)
// ---------------------------------------------------------------------------

export type PauseResult =
  | { verb: "pause"; applied: true; headSeq: number | null }
  | { verb: "pause"; applied: false; reason: "no-live-state" | "already-paused" };

export type ResumeResult =
  | { verb: "resume"; applied: true; drained: number; headSeq: number | null }
  | { verb: "resume"; applied: false; reason: "no-live-state" | "not-paused" };

/** Record one `control` event through the outbox (flush leftovers first, D3). */
async function recordControl(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  entityId: string,
  verb: ControlVerb,
  input: ControlInput,
): Promise<number | null> {
  await config.outbox.flush(ctx, entityId);
  const now = await ctx.run("now-control", () => Date.now());
  const ev: TimelineEventInit = {
    type: "control",
    ts: iso(now),
    payload: {
      verb,
      ...(input.reason !== undefined && { reason: input.reason }),
      ...(input.from !== undefined && { from: input.from }),
    },
  };
  const committed = await commitEventsChunked(ctx, config.outbox, entityId, [ev], chunkOf(config));
  return committed.length > 0 ? committed[committed.length - 1]!.seq : null;
}

/**
 * `pause` (D8) — set the runtime `paused` flag so the NEXT `handleMessage`
 * queues rather than runs (checked at invocation start). Records
 * `control(pause)`. Re-arms the archive timer (activity). No-op on an entity
 * with no live state or already paused.
 */
export async function handlePause(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  input: ControlInput = {},
): Promise<PauseResult> {
  const entityId = entityIdOf(ctx, config);
  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    return { verb: "pause", applied: false, reason: "no-live-state" };
  }
  if ((await ctx.get<boolean>(AGENT_KV.paused)) === true) {
    return { verb: "pause", applied: false, reason: "already-paused" };
  }
  ctx.set(AGENT_KV.paused, true);
  const headSeq = await recordControl(ctx, config, entityId, "pause", input);
  await scheduleArchiveTick(ctx, config);
  return { verb: "pause", applied: true, headSeq };
}

/**
 * `resume` (D8) — clear the `paused` flag and re-enqueue everything queued in
 * `pausedMailbox` as ordinary `message` self-sends (processed in order once
 * unpaused, single-writer FIFO). Records `control(resume)`. No-op when not
 * paused / no live state.
 */
export async function handleResume(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  input: ControlInput = {},
): Promise<ResumeResult> {
  const entityId = entityIdOf(ctx, config);
  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    return { verb: "resume", applied: false, reason: "no-live-state" };
  }
  if ((await ctx.get<boolean>(AGENT_KV.paused)) !== true) {
    return { verb: "resume", applied: false, reason: "not-paused" };
  }
  const mailbox = (await ctx.get<AgentMessageInput[]>(AGENT_KV.pausedMailbox)) ?? [];
  ctx.clear(AGENT_KV.paused);
  ctx.clear(AGENT_KV.pausedMailbox);

  const headSeq = await recordControl(ctx, config, entityId, "resume", input);

  // Re-enqueue queued wakes as normal message self-sends (D2 one-way sends);
  // each becomes its own exclusive invocation, now that `paused` is clear.
  const service = agentServiceName(config.entityType);
  for (const queued of mailbox) {
    ctx.genericSend({ service, method: "message", key: ctx.key, parameter: queued });
  }
  await scheduleArchiveTick(ctx, config);
  return { verb: "resume", applied: true, drained: mailbox.length, headSeq };
}

// ---------------------------------------------------------------------------
// archive (EXCLUSIVE — the D7/T8.1 lifecycle end + "kill")
// ---------------------------------------------------------------------------

export type ArchiveResult =
  | { verb: "archive"; archived: true; snapshotSeq: number; headSeq: number }
  | { verb: "archive"; archived: false; reason: "no-live-state" };

export interface AppliedArchive {
  /** seq of the `state_snapshot(pre_archive)` event. */
  snapshotSeq: number;
  /** seq of the terminal `archived` event (the head seq at archive time). */
  headSeq: number;
}

/**
 * The archive body — shared by the `archive` verb (trigger `requested`) and
 * the idle self-scheduled `archiveTick` (trigger `idle`). Minimal-correct
 * per the frozen schema (A5) and the T8.1 contract sketched at
 * `handleArchiveTick`:
 *
 *  1. flush any leftover outbox (D3), then
 *  2. set `status = archived` so the outbox catalog upsert (which reads
 *     `AGENT_KV.status` at flush time, projection-outbox.ts) transitions the
 *     catalog row to archived alongside the terminal events;
 *  3. commit `control(archive)` + `state_snapshot(pre_archive, state=<bounded
 *     context + metadata>)`; the snapshot event OCCUPIES a seq slot and
 *     asserts state as of that seq (A5);
 *  4. commit the terminal `archived` event carrying `snapshotSeq`;
 *  5. clear ALL K/V (Restate holds the working set only, D7).
 *
 * Persistence (T8.1): the bounded snapshot STATE is written both to the
 * timeline stream (the `state_snapshot(pre_archive)` event) AND — via the
 * `config.archiveCatalog` seam (projection-catalog.ts `createDrizzleArchiveCatalog`)
 * — to the catalog `archived_snapshot` JSONB, which is the archive-of-record
 * resurrection reads from (D1/D7 — never the stream). The snapshot size bound
 * is enforced at write time (`boundArchiveSnapshotState`): it is the bounded
 * context, not the timeline. Resurrection (rehydrate + continue seq from
 * `head_seq`) lives in agent.ts (`resurrectFromCatalog`).
 */
export async function applyArchive(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  opts: { trigger: "idle" | "requested"; reason?: string; from?: string },
): Promise<AppliedArchive> {
  const entityId = entityIdOf(ctx, config);
  const chunk = chunkOf(config);

  await config.outbox.flush(ctx, entityId);

  // Transition status FIRST so the outbox catalog upsert (D1) writes
  // status=archived + the final head_seq together with the terminal events.
  ctx.set<EntityStatus>(AGENT_KV.status, "archived");

  const now = await ctx.run("now-archive", () => Date.now());

  // The resurrection payload (D7: the bounded context, not the timeline),
  // bounded at write time. This exact object is written to the stream snapshot
  // event AND persisted to the catalog `archived_snapshot`; `resurrectFromCatalog`
  // rehydrates the K/V from it.
  const snapshotState = boundArchiveSnapshotState(
    {
      context: (await ctx.get<TimelineEvent[]>(AGENT_KV.context)) ?? [],
      usage: (await ctx.get<RunUsage>(AGENT_KV.usage)) ?? ZERO_RUN_USAGE,
      workspaceRef: (await ctx.get<string>(AGENT_KV.workspaceRef)) ?? null,
      parentRef: (await ctx.get<string>(AGENT_KV.parentRef)) ?? null,
      subscribers: (await ctx.get<string[]>(AGENT_KV.subscribers)) ?? [],
      harness: (await ctx.get<JsonValue>(AGENT_KV.harness)) ?? null,
    },
    config.archiveSnapshotMaxBytes,
  );

  // control(archive) then state_snapshot(pre_archive) — committed together so
  // their seqs are consecutive; read the snapshot's allocated seq back for the
  // terminal event's `snapshotSeq`.
  const preEvents: TimelineEventInit[] = [
    {
      type: "control",
      ts: iso(now),
      payload: {
        verb: "archive",
        ...(opts.reason !== undefined && { reason: opts.reason }),
        ...(opts.from !== undefined && { from: opts.from }),
      },
    },
    {
      type: "state_snapshot",
      ts: iso(now),
      payload: { state: snapshotState as unknown as JsonValue, reason: "pre_archive" },
    },
  ];
  const committedPre = await commitEventsChunked(ctx, config.outbox, entityId, preEvents, chunk);
  const snapshotSeq = committedPre[committedPre.length - 1]!.seq;

  const [archivedEvent] = await commitEventsChunked(
    ctx,
    config.outbox,
    entityId,
    [
      {
        type: "archived",
        ts: iso(now),
        payload: { reason: opts.trigger, snapshotSeq },
      },
    ],
    chunk,
  );
  const headSeq = archivedEvent!.seq;

  // Persist the archive-of-record (D7): the catalog row already carries
  // status=archived + head_seq (the outbox upserts read AGENT_KV.status during
  // the flushes above); this writes the `archived_snapshot` JSONB. Done BEFORE
  // clearing K/V so a crash after clear-but-before-persist can't happen (the
  // persist is journaled inside the seam's ctx.run). Without an archiveCatalog
  // the snapshot lives only on the stream and the entity cannot resurrect
  // (pre-T8.1 behavior).
  await config.archiveCatalog?.persistArchivedSnapshot(ctx, {
    entityId,
    snapshot: snapshotState as unknown as JsonValue,
    snapshotSeq: headSeq,
  });

  // Clear ALL K/V — Restate holds only the working set (D7). The outbox was
  // trimmed by the flushes above; clearing `seq` (AGENT_KV) is what makes the
  // entity "no live state" (handleMessage sees seq===null) until a later
  // message resurrects it from the catalog. The outbox/messaging bookkeeping
  // keys live in their own namespaces, so clear those too for a truly empty
  // working set; resurrection reconstructs `outboxConfirmedSeq` from `head_seq`.
  for (const key of Object.values(AGENT_KV)) ctx.clear(key);
  for (const key of Object.values(OUTBOX_KV)) ctx.clear(key);
  for (const key of Object.values(MESSAGING_KV)) ctx.clear(key);

  return { snapshotSeq, headSeq };
}

/**
 * `archive` verb (D8, trigger `requested`) — the public "kill". Exclusive, so
 * it queues behind any in-flight wake and archives once that wake completes;
 * pair with `interrupt` for an immediate mid-run kill. No-op on an entity with
 * no live state (never spawned / already archived).
 */
export async function handleArchive(
  ctx: AgentRuntimeCtx,
  config: AgentObjectConfig,
  input: ControlInput = {},
): Promise<ArchiveResult> {
  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    return { verb: "archive", archived: false, reason: "no-live-state" };
  }
  const { snapshotSeq, headSeq } = await applyArchive(ctx, config, {
    trigger: "requested",
    ...(input.reason !== undefined && { reason: input.reason }),
    ...(input.from !== undefined && { from: input.from }),
  });
  return { verb: "archive", archived: true, snapshotSeq, headSeq };
}

// ---------------------------------------------------------------------------
// Paused-mailbox helper (used by handleMessage's invocation-start check)
// ---------------------------------------------------------------------------

/**
 * Invocation-start pause gate for `handleMessage` (T2.5): if `paused` is set,
 * append the (already-validated) wake input to `pausedMailbox` and return a
 * `queued` `WakeResult` (no `outcome`) WITHOUT running the harness or recording
 * any event. `resume` later re-enqueues the mailbox. Returns `null` when NOT
 * paused (the caller proceeds with the normal wake).
 */
export async function queueIfPaused(
  ctx: AgentRuntimeCtx,
  entityId: string,
  input: AgentMessageInput,
): Promise<WakeResult | null> {
  if ((await ctx.get<boolean>(AGENT_KV.paused)) !== true) return null;
  const mailbox = (await ctx.get<AgentMessageInput[]>(AGENT_KV.pausedMailbox)) ?? [];
  ctx.set(AGENT_KV.pausedMailbox, [...mailbox, input]);
  const headSeq = headSeqOf(await ctx.get<number>(AGENT_KV.seq));
  return { entityId, headSeq, queued: true };
}
