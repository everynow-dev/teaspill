/**
 * Canonical timeline event schema (0001:T0.1).
 *
 * ============================================================================
 * STATUS: FROZEN (v1) — 0001:Gate 1 passed at 0001:G3 (2026-07-17, 0001:A5).
 * The main session reviewed the CASDK paper-mapping (`docs/casdk-mapping.md`)
 * and pi-ai sketch and confirmed the round-trip is lossless
 * (work/plans/0001-build-v1/PLAN.md §6 0001:Gate 1). From here, breaking changes
 * bump `v` and add a migration; additive-only within v1. The four
 * freeze-review items (control-vs-signal naming, summarization.detail,
 * text+image-only ContentBlock, tool-layer tool_result detail) were all
 * accepted — see 0001:A5.
 * ============================================================================
 *
 * The canonical event is the single vocabulary everything speaks: both
 * harnesses emit it (0001:T3.2, 0001:T7.1), the projection outbox appends it to
 * the per-entity timeline stream (0001:T2.2, 0001:D3), the frontend SDK
 * materializes it (0001:T5.2), snapshots and archives are expressed in it
 * (0001:T8.1). See work/plans/0001-build-v1/DECISIONS.md 0001:D1/0001:D3/0001:D5 and
 * docs/addressing.md.
 *
 * ## Envelope
 *
 * `{ v, entityId, seq, ts, type, payload }`
 *
 * - `v` — schema version, literal `1`. Bumps only on breaking envelope/payload
 *   changes after the freeze.
 * - `entityId` — the canonical entity url (`/t/<tenant>/a/<type>/<id>`,
 *   docs/addressing.md §2). Identical to `entities.url` and to the
 *   durable-streams `Producer-Id` of the entity's outbox.
 * - `seq` — **0-based, gapless, monotonic per entity** (DECISIONS 0001:A1). The
 *   durable-streams idempotent producer (constraint C4) requires
 *   `Producer-Seq` to start at 0 and increase by exactly 1, and the outbox
 *   maps `Producer-Seq = seq` identically. Therefore:
 *     - the FIRST event of every entity has `seq === 0` (and is always
 *       `entity_spawned`);
 *     - EVERY canonical event occupies a seq slot — a `state_snapshot` at
 *       seq N consumes N like any other event; nothing may skip;
 *     - seq is allocated ONLY by the entity's own Restate handler at outbox
 *       time (single-writer, 0001:D3). Harnesses never assign seq — they produce
 *       `TimelineEventInit` (envelope minus `v`/`entityId`/`seq`) and the
 *       outbox finalizes (see `finalizeEvent`).
 *   Token deltas are NOT canonical events and take no seq (see ./deltas.ts).
 * - `ts` — ISO 8601 timestamp (informational; ordering authority is `seq`).
 * - `type`/`payload` — discriminated union below.
 *
 * ## Snapshot ↔ seq semantics (0001:T5.2 fast-join, 0001:T8.1 archive depend on this)
 *
 * A `state_snapshot` event with `seq === N` asserts: *"the state in this
 * payload is the complete materialization of this entity after consuming all
 * canonical events with `seq <= N`."* The snapshot itself mutates nothing
 * (state as-of N equals state as-of N-1), but the INCLUSIVE phrasing is the
 * contract because it makes fast-join trivial and unambiguous:
 *
 *   1. client reads snapshot(seq = N) → initializes state from `payload.state`
 *   2. client consumes events seq N+1, N+2, … (gapless — a gap is drift, 0001:D3)
 *   3. no event with seq <= N is ever needed again for materialization.
 *
 * The catalog's `snapshot_offset` points at such an event; archive (0001:T8.1)
 * writes one immediately before the terminal `archived` event.
 *
 * ## Summarization ↔ seq semantics (context truncation boundary)
 *
 * A `summarization` event with `seq === N` and
 * `payload.replacesThroughSeq === M` (M < N) asserts: for *context assembly*
 * (events → provider messages, 0001:T3.1), the context-bearing events with
 * `seq <= M` are superseded by `payload.summary`. It does NOT delete or
 * compact the stream — history stays intact for UIs; only the LLM-facing
 * projection folds. See `@teaspill/harness-native` `selectContextEvents`.
 *
 * ## `opaque` (0001:R2/0001:R3 lock-in + churn defense)
 *
 * Foreign records with no clean canonical home — unknown/new CASDK record
 * types, provider-specific artifacts — are carried as
 * `{ type: 'opaque', payload: { origin, kind, data } }` so they round-trip
 * losslessly through the timeline instead of being dropped. A cold CASDK
 * rebuild (0001:T7.1) replays `opaque(origin='casdk')` records verbatim; every
 * other consumer may ignore them. `data` must be plain JSON.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Plain-JSON schema. Preserves every key/element — safe for lossless `opaque` payloads. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** ISO 8601 timestamp with optional fractional seconds and offset. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const imageBlockSchema = z.object({
  type: z.literal("image"),
  /** e.g. `image/png` — open string; producers must emit provider-supported types. */
  mimeType: z.string().min(1),
  /** base64 payload. */
  data: z.string(),
});

/**
 * Message/tool-result content. Deliberately tiny (text + image) — attachments
 * are out of scope v1 (PLAN T1.2c) and anything richer a tool wants to convey
 * goes in `tool_result.payload.detail` as JSON.
 */
export const contentBlockSchema = z.discriminatedUnion("type", [textBlockSchema, imageBlockSchema]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

/**
 * Token accounting for a finished run. Field semantics follow the shared
 * pi/Anthropic mapping (see docs/casdk-mapping.md §usage):
 * - `inputTokens` — UNCACHED input: fresh prompt tokens + cache writes
 *   (`input_tokens + cache_creation_input_tokens`). Cache reads excluded.
 * - `cacheReadTokens` — tokens read from the prompt cache.
 * - `outputTokens` — completion tokens.
 * - `contextTokens` — cache-INCLUSIVE prompt size of the last step (what a
 *   "% of context used" gauge needs); optional.
 * - `attempt` — Restate invocation attempt that produced these numbers.
 *   Consumers reconciling usage across retries keep the latest attempt only
 *   (0001:T7.4 double-count rule).
 */
export const runUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative().optional(),
  steps: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  attempt: z.number().int().nonnegative().optional(),
});
export type RunUsage = z.infer<typeof runUsageSchema>;

/** What woke the entity into this run (0001:D2 wake model). */
export const wakeSourceSchema = z.enum([
  "spawn", // first wake, from entity_spawned
  "message", // ordinary message wake (including child_finished deliveries)
  "steer_degraded", // a steer that arrived while idle, degraded to a wake (0001:D2)
  "cron", // delayed/self-scheduled send
  "control", // a control verb triggered processing (e.g. resume)
  "system", // platform-internal (reconciler, archive tick, …)
]);
export type WakeSource = z.infer<typeof wakeSourceSchema>;

export const harnessKindSchema = z.enum(["native", "casdk"]);
export type HarnessKind = z.infer<typeof harnessKindSchema>;

const runOutcomeSchema = z.enum(["success", "error", "interrupted"]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** Always the entity's FIRST event (`seq === 0`). */
export const entitySpawnedPayloadSchema = z.object({
  /** The agent type (same string as in the entity url). */
  entityType: z.string().min(1),
  /** Parent entity url, or null for root entities. */
  parentId: z.string().nullable(),
  /** The validated spawn arguments, as JSON. */
  spawnArgs: jsonValueSchema.optional(),
  /** Workspace key (`<tenant>/<name>`) chosen at spawn (0001:D4: never switched). */
  workspaceRef: z.string().optional(),
});

export const runStartedPayloadSchema = z.object({
  /** Unique per wake/run; every event produced by the run carries it. */
  runId: z.string().min(1),
  wake: z.object({
    source: wakeSourceSchema,
    /** Sender entity url, when the wake was a message/steer from another entity. */
    from: z.string().optional(),
  }),
  harness: harnessKindSchema,
  model: z.string().optional(),
  /** Harness-specific extras (e.g. CASDK session id). Informational only. */
  detail: jsonValueSchema.optional(),
});

export const messageRoleSchema = z.enum(["user", "assistant", "system_note"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/**
 * A finalized conversation message. `system_note` is a platform-authored
 * annotation (e.g. "child x finished", control acknowledgements rendered into
 * context) — it is context-bearing but rendered to providers as a marked user
 * message, never as the API-level system prompt.
 */
export const messagePayloadSchema = z.object({
  /** Stable message id — token deltas reference it (`DeltaRecord.ref`). */
  id: z.string().min(1),
  runId: z.string().optional(),
  role: messageRoleSchema,
  content: z.array(contentBlockSchema),
  /** Sender entity url for inter-agent messages. */
  from: z.string().optional(),
});

export const toolCallPayloadSchema = z.object({
  runId: z.string().min(1),
  /**
   * The provider tool-use id. Third component of the tool idempotency key
   * `(entityUrl, runId, toolUseId)` — the exactly-once contract (0001:T3.1).
   */
  toolUseId: z.string().min(1),
  name: z.string().min(1),
  input: jsonValueSchema,
});

export const toolResultPayloadSchema = z.object({
  runId: z.string().min(1),
  toolUseId: z.string().min(1),
  /** Bare tool name (denormalized for consumers; matches the tool_call). */
  name: z.string().optional(),
  content: z.array(contentBlockSchema),
  /** Structured result detail (diff, exitCode, streamRef, …) for rich renderers. */
  detail: jsonValueSchema.optional(),
  isError: z.boolean(),
});

/**
 * Optional finalized reasoning/thinking. DISPLAY-ONLY history: it is never
 * projected back into provider context (CASDK thinking signatures are
 * unforgeable — see docs/casdk-mapping.md §reasoning) and context assembly
 * skips it.
 */
export const reasoningPayloadSchema = z.object({
  /** Stable id — reasoning deltas reference it. */
  id: z.string().min(1),
  runId: z.string().optional(),
  text: z.string(),
  /** Opaque encrypted/redacted thinking payload (e.g. Anthropic redacted_thinking). */
  encrypted: z.string().optional(),
});

/** See module header: "Snapshot ↔ seq semantics". */
export const stateSnapshotPayloadSchema = z.object({
  /** Complete materialized entity state as of this event's own seq (inclusive). */
  state: jsonValueSchema,
  reason: z.enum(["periodic", "pre_archive", "recovery"]),
  /**
   * True when events before this snapshot may be missing from the stream
   * (0001:D3 catastrophic-stream-loss path). Consumers must not gap-check across
   * a history hole.
   */
  historyHole: z.boolean().optional(),
});

/** See module header: "Summarization ↔ seq semantics". */
export const summarizationPayloadSchema = z.object({
  runId: z.string().optional(),
  summary: z.string().min(1),
  /**
   * Context-bearing events with seq <= this value are superseded by `summary`
   * for context assembly. MUST be < the event's own seq.
   */
  replacesThroughSeq: z.number().int().nonnegative(),
  /**
   * Producer metadata about the truncation (e.g. CASDK `compact_metadata`:
   * trigger, pre_tokens). Informational only — never affects the fold.
   */
  detail: jsonValueSchema.optional(),
});

export const controlVerbSchema = z.enum(["interrupt", "pause", "resume", "archive"]);
export type ControlVerb = z.infer<typeof controlVerbSchema>;

/**
 * A control verb was applied (0001:T2.5/0001:D8 minimal verb API — PLAN's 0001:T0.1 vocabulary
 * calls this slot `signal`; it is named `control` here to match the 0001:D8 decision
 * that dropped the POSIX signal vocabulary).
 */
export const controlPayloadSchema = z.object({
  verb: controlVerbSchema,
  reason: z.string().optional(),
  /** Requesting principal/entity, when known. */
  from: z.string().optional(),
});

export const errorPayloadSchema = z.object({
  runId: z.string().optional(),
  /** Stable machine-readable code (e.g. `claude_sdk_inactivity_timeout`). */
  code: z.string().optional(),
  message: z.string().min(1),
  source: z.enum(["harness", "tool", "platform", "provider", "projection"]),
  detail: jsonValueSchema.optional(),
});

export const runFinishedPayloadSchema = z.object({
  runId: z.string().min(1),
  outcome: runOutcomeSchema,
  usage: runUsageSchema,
  durationMs: z.number().int().nonnegative().optional(),
  detail: jsonValueSchema.optional(),
});

export const childSpawnedPayloadSchema = z.object({
  /** Child entity url. */
  childId: z.string().min(1),
  childType: z.string().min(1),
  runId: z.string().optional(),
  /** The spawning tool call, when spawned by a tool. */
  toolUseId: z.string().optional(),
});

export const childFinishedPayloadSchema = z.object({
  childId: z.string().min(1),
  outcome: z.enum(["success", "error", "interrupted", "archived"]),
  result: jsonValueSchema.optional(),
});

/**
 * Terminal event of an archive episode (0001:D7). A
 * `state_snapshot(reason='pre_archive')` immediately precedes it. NOT globally
 * terminal: resurrection (0001:T8.1) rehydrates from the catalog snapshot and
 * CONTINUES the same seq counter from `head_seq` — the next event after an
 * `archived` is the resurrecting wake's `run_started`.
 */
export const archivedPayloadSchema = z.object({
  reason: z.enum(["idle", "requested"]),
  /** seq of the pre-archive state_snapshot event. */
  snapshotSeq: z.number().int().nonnegative().optional(),
});

/** See module header: "`opaque`". */
export const opaquePayloadSchema = z.object({
  /** Producing system, e.g. `casdk`, `pi-ai`. */
  origin: z.string().min(1),
  /** Foreign record type/subtype, e.g. `system/status`, `session/file-history-snapshot`. */
  kind: z.string().min(1),
  /** The foreign record, verbatim JSON. Round-trips losslessly. */
  data: jsonValueSchema,
});

// ---------------------------------------------------------------------------
// Envelope + discriminated union
// ---------------------------------------------------------------------------

export const EVENT_SCHEMA_VERSION = 1 as const;

const envelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    v: z.literal(EVENT_SCHEMA_VERSION),
    /** Canonical entity url (docs/addressing.md §2). */
    entityId: z.string().min(1),
    /** 0-based, gapless per entity (DECISIONS 0001:A1). */
    seq: z.number().int().nonnegative(),
    ts: isoTimestampSchema,
    type: z.literal(type),
    payload,
  });

export const entitySpawnedEventSchema = envelope("entity_spawned", entitySpawnedPayloadSchema);
export const runStartedEventSchema = envelope("run_started", runStartedPayloadSchema);
export const messageEventSchema = envelope("message", messagePayloadSchema);
export const toolCallEventSchema = envelope("tool_call", toolCallPayloadSchema);
export const toolResultEventSchema = envelope("tool_result", toolResultPayloadSchema);
export const reasoningEventSchema = envelope("reasoning", reasoningPayloadSchema);
export const stateSnapshotEventSchema = envelope("state_snapshot", stateSnapshotPayloadSchema);
export const summarizationEventSchema = envelope("summarization", summarizationPayloadSchema);
export const controlEventSchema = envelope("control", controlPayloadSchema);
export const errorEventSchema = envelope("error", errorPayloadSchema);
export const runFinishedEventSchema = envelope("run_finished", runFinishedPayloadSchema);
export const childSpawnedEventSchema = envelope("child_spawned", childSpawnedPayloadSchema);
export const childFinishedEventSchema = envelope("child_finished", childFinishedPayloadSchema);
export const archivedEventSchema = envelope("archived", archivedPayloadSchema);
export const opaqueEventSchema = envelope("opaque", opaquePayloadSchema);

/** The canonical timeline event — discriminated on `type`. */
export const timelineEventSchema = z.discriminatedUnion("type", [
  entitySpawnedEventSchema,
  runStartedEventSchema,
  messageEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  reasoningEventSchema,
  stateSnapshotEventSchema,
  summarizationEventSchema,
  controlEventSchema,
  errorEventSchema,
  runFinishedEventSchema,
  childSpawnedEventSchema,
  childFinishedEventSchema,
  archivedEventSchema,
  opaqueEventSchema,
]);

export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type EventType = TimelineEvent["type"];

export type EntitySpawnedEvent = z.infer<typeof entitySpawnedEventSchema>;
export type RunStartedEvent = z.infer<typeof runStartedEventSchema>;
export type MessageEvent = z.infer<typeof messageEventSchema>;
export type ToolCallEvent = z.infer<typeof toolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof toolResultEventSchema>;
export type ReasoningEvent = z.infer<typeof reasoningEventSchema>;
export type StateSnapshotEvent = z.infer<typeof stateSnapshotEventSchema>;
export type SummarizationEvent = z.infer<typeof summarizationEventSchema>;
export type ControlEvent = z.infer<typeof controlEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type RunFinishedEvent = z.infer<typeof runFinishedEventSchema>;
export type ChildSpawnedEvent = z.infer<typeof childSpawnedEventSchema>;
export type ChildFinishedEvent = z.infer<typeof childFinishedEventSchema>;
export type ArchivedEvent = z.infer<typeof archivedEventSchema>;
export type OpaqueEvent = z.infer<typeof opaqueEventSchema>;

export const EVENT_TYPES = [
  "entity_spawned",
  "run_started",
  "message",
  "tool_call",
  "tool_result",
  "reasoning",
  "state_snapshot",
  "summarization",
  "control",
  "error",
  "run_finished",
  "child_spawned",
  "child_finished",
  "archived",
  "opaque",
] as const satisfies readonly EventType[];

// Compile-time exhaustiveness: EVENT_TYPES covers every union member.
type _AssertExhaustive = EventType extends (typeof EVENT_TYPES)[number] ? true : never;
const _exhaustive: _AssertExhaustive = true;
void _exhaustive;

// ---------------------------------------------------------------------------
// Event init (harness → outbox hand-off)
// ---------------------------------------------------------------------------

/** Distributive Omit that preserves union discrimination. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * A canonical event as PRODUCED by a harness or handler, before the entity's
 * outbox finalizes it. Harnesses never assign `v`, `entityId`, or `seq` —
 * seq allocation is exclusively the single-writer entity handler's job at
 * outbox commit time (0001:D3/0001:A1). This split is what makes 0-based-gapless
 * enforceable: exactly one allocator per entity.
 */
export type TimelineEventInit = DistributiveOmit<TimelineEvent, "v" | "entityId" | "seq">;

/**
 * Finalize a harness-produced event into a full canonical event. Called by
 * the outbox (0001:T2.2) with the seq it atomically allocated. Validates the
 * result — a malformed event must never reach the stream.
 */
export function finalizeEvent(
  init: TimelineEventInit,
  opts: { entityId: string; seq: number },
): TimelineEvent {
  return timelineEventSchema.parse({
    v: EVENT_SCHEMA_VERSION,
    entityId: opts.entityId,
    seq: opts.seq,
    ...init,
  });
}

// ---------------------------------------------------------------------------
// Parse / validate helpers
// ---------------------------------------------------------------------------

/** Parse an unknown value into a canonical event. Throws on invalid input. */
export function parseTimelineEvent(input: unknown): TimelineEvent {
  return timelineEventSchema.parse(input);
}

/** Non-throwing variant. */
export function safeParseTimelineEvent(input: unknown): z.ZodSafeParseResult<TimelineEvent> {
  return timelineEventSchema.safeParse(input);
}

export function isTimelineEvent(input: unknown): input is TimelineEvent {
  return timelineEventSchema.safeParse(input).success;
}

/** Parse one JSON-encoded stream record into a canonical event. */
export function parseTimelineEventJson(json: string): TimelineEvent {
  return parseTimelineEvent(JSON.parse(json));
}

export interface SeqContiguityResult {
  ok: boolean;
  /** Index into `events` of the first violation, when !ok. */
  violationAt?: number;
  /** The seq that was expected at that index. */
  expectedSeq?: number;
}

/**
 * Check the 0001:A1 invariant over an ordered slice of a timeline: seq must start
 * at `expectedFirstSeq` (default 0 — a full timeline) and increase by exactly
 * 1. This is the client-side drift/gap detector primitive (0001:D3, 0001:T5.2): a
 * client joining from a snapshot at seq N passes `expectedFirstSeq: N + 1`.
 */
export function checkSeqContiguity(
  events: readonly Pick<TimelineEvent, "seq">[],
  opts: { expectedFirstSeq?: number } = {},
): SeqContiguityResult {
  let expected = opts.expectedFirstSeq ?? 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.seq !== expected) {
      return { ok: false, violationAt: i, expectedSeq: expected };
    }
    expected += 1;
  }
  return { ok: true };
}

/**
 * Structural invariants that hold across events, beyond per-event shape:
 * - a full timeline (starting at seq 0) begins with `entity_spawned`, and
 *   `entity_spawned` appears nowhere else;
 * - a `summarization` event's `replacesThroughSeq` is < its own seq.
 * (`archived` is deliberately NOT checked as terminal — resurrection
 * continues the same seq counter, see archivedPayloadSchema.)
 * Returns a list of human-readable violations (empty = valid). Intended for
 * tests, the reconciler, and conformance kits — not the hot path.
 */
export function checkTimelineInvariants(events: readonly TimelineEvent[]): string[] {
  const violations: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type === "entity_spawned" && ev.seq !== 0) {
      violations.push(`entity_spawned at seq ${ev.seq} — it must be the first event (seq 0)`);
    }
    if (ev.seq === 0 && ev.type !== "entity_spawned") {
      violations.push(`first event (seq 0) is ${ev.type}, not entity_spawned`);
    }
    if (ev.type === "summarization" && ev.payload.replacesThroughSeq >= ev.seq) {
      violations.push(
        `summarization at seq ${ev.seq} has replacesThroughSeq ${ev.payload.replacesThroughSeq} >= its own seq`,
      );
    }
  }
  return violations;
}
