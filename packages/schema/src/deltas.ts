/**
 * Token-delta sub-events (T0.1 framing decision + T5.1 hand-off).
 *
 * STATUS: PROPOSED alongside events.ts — see that file's freeze note.
 *
 * ## The decision: deltas ride a SIBLING `/deltas` STREAM, not the timeline
 *
 * docs/addressing.md §4.2 reserves `/t/<tenant>/agents/<type>/<id>/deltas`
 * for exactly this option; the alternative was interleaving deltas into the
 * timeline stream as non-seq records. Sibling stream wins, for four reasons:
 *
 * 1. **A1/C4 make interleaving structurally hostile.** The timeline is
 *    written through the durable-streams idempotent producer whose sequence
 *    MUST be 0-based and gapless (`Producer-Seq = seq`, DECISIONS A1,
 *    addressing C4). Deltas are explicitly ephemeral/droppable and take no
 *    seq — interleaved, they would either need fake seq slots (dropping one
 *    then CREATES a gap the producer rejects) or ride outside the producer
 *    protocol, putting a second, non-idempotent writer on the entity's
 *    single-producer stream with undefined ordering relative to committed
 *    events.
 * 2. **Different write paths, different guarantees.** Timeline events commit
 *    through the K/V outbox inside the entity handler (exactly-once, D3).
 *    Deltas are fire-and-forget from inside a live harness run (`emitDelta`,
 *    T3.1) — they must be droppable when the streams server is down while the
 *    run proceeds. One stream per guarantee keeps both protocols honest; the
 *    timeline's drift detector (seq-gap check) stays exact instead of having
 *    to skip unnumbered records.
 * 3. **Retention divergence (T5.1).** Delta history is worthless after the
 *    finalized event lands; the sibling stream can be truncated or deleted
 *    wholesale without touching authoritative history. Interleaved deltas
 *    would bloat the timeline forever (or require the compaction protocol D8
 *    explicitly dropped).
 * 4. **Consumer divergence.** UIs read the timeline for history/fast-join
 *    (cacheable, resumable) and subscribe to `/deltas` only for live
 *    entities. Keeping high-churn delta traffic off the timeline preserves
 *    its HTTP cacheability (D1).
 *
 * ## Contract
 *
 * - Deltas are EXCLUDED from `seq`; they carry no envelope seq at all.
 * - Every delta references the canonical event it streams toward via `ref`
 *   (the `message.payload.id`, `reasoning.payload.id`, or `toolUseId` the
 *   finalized event will carry).
 * - Best-effort ordering only: `idx` is a per-`ref` monotonically increasing
 *   chunk counter for UI assembly; GAPS ARE ALLOWED (dropped chunks are
 *   normal, not drift).
 * - **The finalized event always wins** (T5.2 reducer dedup rule): once the
 *   timeline carries the finalized event with id == `ref`, all buffered
 *   deltas for that ref are discarded. Deltas are never used to reconstruct
 *   state or context (D1: streams are never read to decide what to do — and
 *   deltas aren't even reliable history).
 * - `attempt` distinguishes Restate retry attempts of the same run: on a
 *   retried run the same ref may stream again; consumers render the highest
 *   attempt and drop the rest (T7.4).
 */

import { z } from "zod";
import { isoTimestampSchema, runUsageSchema } from "./events.js";

export const DELTA_SCHEMA_VERSION = 1 as const;

/** Where token deltas live: the sibling `/deltas` stream (see module doc). */
export const DELTA_FRAMING = "sibling-stream" as const;

const deltaBase = {
  v: z.literal(DELTA_SCHEMA_VERSION),
  /** Canonical entity url. */
  entityId: z.string().min(1),
  runId: z.string().min(1),
  /** Restate invocation attempt (retry disambiguation, T7.4). */
  attempt: z.number().int().nonnegative().optional(),
  /** Id of the canonical event this delta streams toward. */
  ref: z.string().min(1),
  /** Per-ref chunk counter. Best-effort; gaps allowed. */
  idx: z.number().int().nonnegative(),
  ts: isoTimestampSchema,
};

/** Streaming chunk of an assistant message's text (`ref` = message id). */
export const textDeltaSchema = z.object({
  ...deltaBase,
  kind: z.literal("text"),
  text: z.string(),
});

/** Streaming chunk of reasoning/thinking (`ref` = reasoning id). */
export const reasoningDeltaSchema = z.object({
  ...deltaBase,
  kind: z.literal("reasoning"),
  text: z.string(),
});

/** Streaming chunk of a tool call's input JSON (`ref` = toolUseId). */
export const toolInputDeltaSchema = z.object({
  ...deltaBase,
  kind: z.literal("tool_input"),
  /** Partial JSON text, as streamed by the provider. */
  text: z.string(),
});

/**
 * Live usage progress (`ref` = runId). Best-effort mid-run counters; the
 * authoritative figure is `run_finished.payload.usage` on the timeline.
 */
export const usageDeltaSchema = z.object({
  ...deltaBase,
  kind: z.literal("usage"),
  usage: runUsageSchema.partial(),
});

export const deltaRecordSchema = z.discriminatedUnion("kind", [
  textDeltaSchema,
  reasoningDeltaSchema,
  toolInputDeltaSchema,
  usageDeltaSchema,
]);

export type DeltaRecord = z.infer<typeof deltaRecordSchema>;
export type DeltaKind = DeltaRecord["kind"];

export const DELTA_KINDS = [
  "text",
  "reasoning",
  "tool_input",
  "usage",
] as const satisfies readonly DeltaKind[];

type _AssertDeltaExhaustive = DeltaKind extends (typeof DELTA_KINDS)[number] ? true : never;
const _deltaExhaustive: _AssertDeltaExhaustive = true;
void _deltaExhaustive;

/** Distributive Omit preserving discrimination. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * A delta as EMITTED by a harness through `emitDelta` (T3.1). The delta sink
 * (platform side) stamps `v` and `entityId`; the harness supplies the rest.
 */
export type DeltaInit = DistributiveOmit<DeltaRecord, "v" | "entityId">;

export function parseDeltaRecord(input: unknown): DeltaRecord {
  return deltaRecordSchema.parse(input);
}

export function safeParseDeltaRecord(input: unknown): z.ZodSafeParseResult<DeltaRecord> {
  return deltaRecordSchema.safeParse(input);
}
