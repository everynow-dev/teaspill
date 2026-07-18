/**
 * Archive snapshot payload — the compact state 0001:D7 archives to the catalog and
 * 0001:T8.1 resurrection rehydrates from (shared contract between control.ts's
 * `applyArchive` writer and agent.ts's `resurrectFromCatalog` reader).
 *
 * The snapshot is the BOUNDED CONTEXT, not the timeline (0001:D7): the K/V
 * conversation context (already summarization-folded), cumulative usage, and
 * the pointers a live entity needs (workspace / parent / subscribers / opaque
 * harness continuation state). It is deliberately small — the timeline stream
 * remains the authoritative history (0001:D1). The size bound below is enforced at
 * WRITE time (PLAN 0001:T8.1 anticipate: "enforce the bound at write time"), so an
 * archived row can never carry an unbounded blob into Postgres.
 */

import * as restate from "@restatedev/restate-sdk";
import type { JsonValue, RunUsage, TimelineEvent } from "@teaspill/schema";

/**
 * Default archive-snapshot size cap. 256 KiB matches the snapshot-policy byte
 * cadence (0001:A7): the bounded context should sit well under it, so the cap only
 * bites a pathological run. Comfortably below the outbox ~1 MiB per-event
 * journal budget (0001:A4), so the `state_snapshot` stream event it also feeds never
 * trips `OutboxBudgetError`.
 */
export const DEFAULT_MAX_ARCHIVE_SNAPSHOT_BYTES = 256 * 1024;

/**
 * The resurrection payload. Written verbatim to the `state_snapshot(pre_archive)`
 * event's `state` AND to the catalog `archived_snapshot` JSONB; read back by
 * `resurrectFromCatalog` to rebuild the entity K/V.
 */
export interface ArchiveSnapshotState {
  /** The bounded conversation context (K/V `context`) at archive time. */
  context: TimelineEvent[];
  /** Cumulative usage (K/V `usage`). */
  usage: RunUsage;
  /** Workspace key, or null (0001:D4 — chosen at spawn, never switched). */
  workspaceRef: string | null;
  /** Parent entity url, or null. */
  parentRef: string | null;
  /** Subscriber entity urls (0001:D2 pub/sub). */
  subscribers: string[];
  /** Opaque per-harness continuation state (0001:D5), or null. */
  harness: JsonValue | null;
  /** Set true when the write-time size bound dropped the oldest context events. */
  contextTruncated?: boolean;
  /** How many oldest context events the bound dropped (0/absent ⇒ none). */
  droppedContextEvents?: number;
}

/** Thrown when even an empty-context snapshot exceeds the bound (non-context state too large). */
export class ArchiveSnapshotTooLargeError extends restate.TerminalError {
  constructor(message: string) {
    super(message, { errorCode: 413 });
    this.name = "ArchiveSnapshotTooLargeError";
  }
}

/** Serialized-JSON byte size, the same measure the outbox uses at append time (0001:R4). */
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/**
 * Enforce the archive-snapshot size bound at write time. Returns the state
 * unchanged when it already fits. When it exceeds `maxBytes`, drops the OLDEST
 * context events (keeping the most recent — the most relevant to resume) until
 * it fits, flagging `contextTruncated` + `droppedContextEvents`. If it still
 * exceeds the bound after dropping the entire context, the non-context state
 * itself is oversized (a misconfiguration) → `ArchiveSnapshotTooLargeError`.
 * Pure.
 */
export function boundArchiveSnapshotState(
  state: ArchiveSnapshotState,
  maxBytes: number = DEFAULT_MAX_ARCHIVE_SNAPSHOT_BYTES,
): ArchiveSnapshotState {
  if (serializedBytes(state) <= maxBytes) return state;

  const context = [...state.context];
  let dropped = 0;
  while (context.length > 0) {
    context.shift();
    dropped += 1;
    if (serializedBytes({ ...state, context }) <= maxBytes) break;
  }
  const bounded: ArchiveSnapshotState = {
    ...state,
    context,
    contextTruncated: true,
    droppedContextEvents: dropped,
  };
  if (serializedBytes(bounded) > maxBytes) {
    throw new ArchiveSnapshotTooLargeError(
      `archive snapshot exceeds ${maxBytes} bytes even with an empty context ` +
        `(non-context state is ${serializedBytes({ ...bounded, context: [] })} bytes). ` +
        `The archive snapshot must be the bounded context, not bulk data.`,
    );
  }
  return bounded;
}
