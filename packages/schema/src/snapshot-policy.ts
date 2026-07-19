/**
 * Snapshot cadence policy + fast-join selection (0001:T5.1).
 *
 * ADDITIVE to the FROZEN v1 schema (DECISIONS 0001:A5): this module adds pure
 * helpers ON TOP of `events.ts`/`deltas.ts` and changes no event type. It
 * answers two questions the platform asks around `state_snapshot` events:
 *
 *   1. **WHEN to emit** a `state_snapshot` — `shouldSnapshot(...)`. The agent
 *      object (0001:T2.1) calls this at outbox time (after staging a wake's events,
 *      before/around the flush) to decide whether to also stage a periodic
 *      `state_snapshot`. Forced reasons (`pre_archive` from 0001:T8.1/0001:D7,
 *      `recovery` from 0001:D3) always snapshot; `periodic` defers to thresholds.
 *   2. **WHERE to fast-join** — `selectFastJoinSnapshot(...)` /
 *      `fastJoinFromSeq(...)`. Given the snapshots a stream/catalog exposes,
 *      pick the one a mid-stream joiner (0001:T5.2) or the reconciler (0001:T5.3) should
 *      initialize from, and the first seq to consume after it (0001:A5's inclusive
 *      snapshot@N ⇒ resume at N+1 contract).
 *
 * All functions are PURE — no I/O, no clock. Wiring into the agent handler is
 * a later task (0001:T2.1/0001:T8.1 for emission, 0001:T5.2/0001:T5.3 for join); this module only
 * carries the decision logic they import. See https://teaspill.everynow.dev/concepts/timelines-events.
 *
 * Snapshots do NOT change reader dedup (DECISIONS 0001:A6): a `state_snapshot`
 * occupies a seq slot like any event and is deduped by its embedded `seq`
 * exactly as every other record; the fold rules (0001:A5) are unaffected.
 */

import type { StateSnapshotEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Why a `state_snapshot` is emitted. Mirrors
 * `stateSnapshotPayloadSchema.shape.reason` in the FROZEN events.ts (kept in
 * lockstep by the compile-time assertion below — this file never edits the
 * frozen schema).
 *
 * - `periodic` — cadence-driven (this module's thresholds). The only reason
 *   `shouldSnapshot` evaluates thresholds for.
 * - `pre_archive` — written immediately before the terminal `archived` event
 *   (0001:D7 / 0001:T8.1). ALWAYS emitted.
 * - `recovery` — catastrophic stream loss / drift repair (0001:D3 / 0001:T5.3); usually
 *   carries `historyHole: true`. ALWAYS emitted.
 */
export type SnapshotReason = "periodic" | "pre_archive" | "recovery";

// Compile-time lockstep with the frozen schema: SnapshotReason must be exactly
// the state_snapshot payload's `reason` union. If events.ts ever changes the
// enum, this fails to typecheck instead of drifting silently.
type _SchemaReason = StateSnapshotEvent["payload"]["reason"];
type _ReasonInSync = [SnapshotReason] extends [_SchemaReason]
  ? [_SchemaReason] extends [SnapshotReason]
    ? true
    : never
  : never;
const _reasonInSync: _ReasonInSync = true;
void _reasonInSync;

/** Reasons that force a snapshot regardless of cadence thresholds. */
export const FORCED_SNAPSHOT_REASONS = ["pre_archive", "recovery"] as const;

export function isForcedSnapshotReason(reason: SnapshotReason): boolean {
  return reason === "pre_archive" || reason === "recovery";
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface SnapshotPolicy {
  /**
   * Emit a periodic snapshot once at least this many seq slots have been
   * consumed since the last `state_snapshot` (or since seq 0 if none yet).
   * `0` disables the seq trigger.
   */
  everySeqInterval: number;
  /**
   * Emit a periodic snapshot once at least this many bytes of canonical
   * events (serialized-JSON size, as the outbox measures at append time) have
   * accumulated since the last `state_snapshot`. `0` disables the byte
   * trigger. Bounds fast-join replay COST for large-payload runs (a few tool
   * results can dwarf the seq count). Either trigger crossing fires.
   */
  everyByteInterval: number;
  /**
   * Floor: never emit a *periodic* snapshot when fewer than this many seq
   * slots have advanced since the last one, even if the byte trigger crossed.
   * Prevents snapshot spam on a burst of large payloads. Must be >= 1 (a
   * snapshot at the same seq as the previous one is meaningless). Forced
   * reasons ignore this floor.
   */
  minSeqInterval: number;
}

/**
 * Default cadence. Chosen so a mid-stream joiner (0001:T5.2) replays at most ~200
 * events or ~256 KiB past the snapshot, while periodic snapshots stay sparse
 * enough not to bloat the timeline (snapshot state is the BOUNDED context, not
 * the history — 0001:D7/0001:T8.1). Deployments may override per agent type later.
 */
export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  everySeqInterval: 200,
  everyByteInterval: 256 * 1024,
  minSeqInterval: 1,
};

// ---------------------------------------------------------------------------
// shouldSnapshot
// ---------------------------------------------------------------------------

export interface SnapshotTriggerInput {
  /**
   * seq slots consumed since the last `state_snapshot` — i.e.
   * `nextSeq - (lastSnapshotSeq + 1)`, or `nextSeq` if the entity has never
   * snapshotted. `0` means the most recent event WAS a snapshot.
   */
  seqSinceLastSnapshot: number;
  /**
   * Serialized-JSON bytes of canonical events appended since the last
   * `state_snapshot`. The outbox already has this figure at append time (0001:R4).
   */
  bytesSinceLastSnapshot: number;
  /**
   * Contextual reason. `pre_archive`/`recovery` force a snapshot; `periodic`
   * or omitted evaluates the cadence thresholds. This lets one call site funnel
   * every snapshot decision through `shouldSnapshot`.
   */
  reason?: SnapshotReason;
}

/**
 * Decide whether to emit a `state_snapshot` now.
 *
 * - Forced reasons (`pre_archive`, `recovery`) ⇒ always `true`.
 * - Otherwise ⇒ `true` iff the seq floor is met AND (the seq trigger OR the
 *   byte trigger crossed). A disabled trigger (`0`) never fires on its own.
 */
export function shouldSnapshot(
  input: SnapshotTriggerInput,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
): boolean {
  if (input.reason !== undefined && isForcedSnapshotReason(input.reason)) {
    return true;
  }
  const floor = Math.max(1, policy.minSeqInterval);
  if (input.seqSinceLastSnapshot < floor) {
    return false;
  }
  const seqCrossed = policy.everySeqInterval > 0 && input.seqSinceLastSnapshot >= policy.everySeqInterval;
  const byteCrossed =
    policy.everyByteInterval > 0 && input.bytesSinceLastSnapshot >= policy.everyByteInterval;
  return seqCrossed || byteCrossed;
}

// ---------------------------------------------------------------------------
// Fast-join selection (0001:A5 contract; complements checkSeqContiguity)
// ---------------------------------------------------------------------------

/**
 * A candidate snapshot to fast-join from — the minimal shape both a catalog
 * `snapshot_offset` row and a scan of `state_snapshot` events can provide.
 */
export interface FastJoinCandidate {
  /** seq of the `state_snapshot` event (0001:A5: state is complete as of `seq <= this`). */
  seq: number;
  /**
   * `state_snapshot.payload.historyHole` — true when events before this
   * snapshot may be missing (0001:D3 recovery). Still a VALID join point (a
   * snapshot is a full state); flagged so a consumer can surface the hole.
   */
  historyHole?: boolean;
}

/**
 * Pick the snapshot to fast-join from: the greatest-`seq` candidate (the most
 * recent complete state ⇒ the fewest events to replay). Returns `null` when
 * there are no snapshots — the caller then joins from seq 0 (the full
 * timeline, which by 0001:A1 begins with `entity_spawned`).
 *
 * A `historyHole` snapshot is NOT excluded: it is the correct, and often the
 * only, join point after a recovery — the hole is upstream of it and never
 * re-materialized. Ties on `seq` keep the first occurrence (snapshots are
 * unique per seq in a well-formed timeline).
 */
export function selectFastJoinSnapshot<T extends FastJoinCandidate>(
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (best === null || c.seq > best.seq) {
      best = c;
    }
  }
  return best;
}

/**
 * The first seq a client must consume AFTER loading a chosen snapshot. 0001:A5's
 * snapshot@N is INCLUSIVE (state covers `seq <= N`), so resume at `N + 1`.
 * Given `null` (no snapshot) ⇒ `0`: consume the whole timeline. Feed the
 * result straight into `checkSeqContiguity(events, { expectedFirstSeq })`.
 */
export function fastJoinFromSeq(snapshot: FastJoinCandidate | null): number {
  return snapshot === null ? 0 : snapshot.seq + 1;
}
