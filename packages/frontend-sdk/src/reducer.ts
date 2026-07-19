/**
 * Timeline reducer (0001:T5.2): folds the canonical per-entity timeline stream
 * (FROZEN v1 events, DECISIONS 0001:A5) + the sibling `/deltas` stream into
 * materialized UI collections. Pure — no I/O, no clock; `createAgentTimeline`
 * (timeline.ts) wires it to `@durable-streams/client`.
 *
 * ## The three ordering rules (in decision terms)
 *
 * 1. **Idempotent on canonical `seq` (0001:A6).** The durable-streams server
 *    persists producer-dedup state debounced, so a server crash can readmit
 *    an already-acked append as a same-seq duplicate stream record. Readers
 *    therefore dedup by the event's embedded `seq`: any record with
 *    `seq <= appliedThroughSeq` is dropped as a duplicate (counted in
 *    `duplicatesDropped`) and is NOT drift.
 *
 * 2. **Fast-join from a snapshot (0001:A7/0001:A5).** `state_snapshot(seq=N)` asserts
 *    the complete entity state after consuming all events with `seq <= N`.
 *    With `fromSnapshot: { seq: N }`, the reducer skips records with
 *    `seq < N`, initializes `entityState` from the snapshot's payload, and
 *    consumes N+1, N+2, … — feed `fastJoinFromSeq`/`checkSeqContiguity`
 *    (schema) the same N to plan/verify the read. Collections then cover the
 *    post-join window only; pre-N history is a separate full read, never
 *    reconstructed from the snapshot's opaque state. A snapshot with
 *    `seq > N` is also accepted as the join point (the catalog's
 *    `snapshot_offset` is a monotonic floor, 0001:A6 #5). If the promised
 *    snapshot never appears, that is `drift.kind = "missing_join_snapshot"`
 *    — loud, never silent.
 *
 * 3. **Delta interleaving — THE FINALIZED EVENT ALWAYS WINS** (the dedup
 *    rule, mirrored from the frozen `deltas.ts` contract). Delta chunks are
 *    merged per `ref` (message id / reasoning id / toolUseId / runId) in
 *    `idx` order (gaps allowed — dropped chunks are normal, not drift; same
 *    `idx` twice keeps the first). The moment the finalized timeline event
 *    with id == `ref` lands (`message`/`reasoning`/`tool_call`, or
 *    `run_finished` for usage), the buffered delta entry is discarded and
 *    ALL later chunks for that ref are dropped on arrival. `run_finished`
 *    additionally sweeps every leftover delta of its run (a never-finalized
 *    trailing partial — the 0001:D5-documented loss window) and drops any
 *    late-arriving chunk of that run. A higher Restate `attempt` resets a
 *    ref's buffer; lower-attempt stragglers drop (0001:T7.4).
 *
 * ## Drift (0001:D3/0001:A1) vs sanctioned discontinuities
 *
 * seq is 0-based and gapless per entity (0001:A1), so a forward gap is drift —
 * surfaced in `drift`/`driftCount`, with resync-and-continue semantics (the
 * event still applies so the UI shows the live tail; consumers should offer
 * a reload). The ONLY sanctioned discontinuity is a `state_snapshot` with
 * `historyHole: true` (0001:D3 catastrophic-loss recovery): the reducer jumps to
 * it without drift and sets `historyHole` (https://teaspill.everynow.dev/concepts/timelines-events — never
 * gap-check across a history hole).
 *
 * ## Immutability
 *
 * `apply*` functions return a NEW state; the input is never mutated
 * (unchanged collection items are shared structurally, so `===` checks on
 * items remain meaningful for memoized renderers).
 */

import type {
  ContentBlock,
  ControlVerb,
  DeltaRecord,
  EntitySpawnedEvent,
  EventType,
  HarnessKind,
  JsonValue,
  MessageRole,
  RunStartedEvent,
  RunUsage,
  TimelineEvent,
} from "@teaspill/schema";

// ---------------------------------------------------------------------------
// View types (the materialized collections)
// ---------------------------------------------------------------------------

export interface RunView {
  runId: string;
  /** seq of `run_started`; absent for an orphan `run_finished` (fast-join). */
  startedSeq?: number;
  ts?: string;
  wake?: RunStartedEvent["payload"]["wake"];
  harness?: HarnessKind;
  model?: string;
  detail?: JsonValue;
  finishedSeq?: number;
  outcome?: "success" | "error" | "interrupted";
  usage?: RunUsage;
  durationMs?: number;
}

export interface MessageView {
  id: string;
  seq: number;
  ts: string;
  role: MessageRole;
  content: ContentBlock[];
  runId?: string;
  from?: string;
}

export interface ToolCallView {
  toolUseId: string;
  runId: string;
  name?: string;
  /** seq of `tool_call`; absent for an orphan `tool_result` (fast-join). */
  callSeq?: number;
  callTs?: string;
  input?: JsonValue;
  resultSeq?: number;
  resultTs?: string;
  result?: { content: ContentBlock[]; detail?: JsonValue; isError: boolean };
}

export interface ReasoningView {
  id: string;
  seq: number;
  ts: string;
  runId?: string;
  text: string;
  encrypted?: string;
}

export interface ChildView {
  childId: string;
  childType?: string;
  spawnedSeq?: number;
  runId?: string;
  toolUseId?: string;
  finishedSeq?: number;
  outcome?: "success" | "error" | "interrupted" | "archived";
  result?: JsonValue;
}

export interface ControlView {
  seq: number;
  ts: string;
  verb: ControlVerb;
  reason?: string;
  from?: string;
}

export interface ErrorView {
  seq: number;
  ts: string;
  runId?: string;
  code?: string;
  message: string;
  source: "harness" | "tool" | "platform" | "provider" | "projection";
  detail?: JsonValue;
}

export interface SummarizationView {
  seq: number;
  ts: string;
  runId?: string;
  summary: string;
  replacesThroughSeq: number;
}

export interface SnapshotView {
  seq: number;
  ts: string;
  reason: "periodic" | "pre_archive" | "recovery";
  historyHole?: boolean;
}

export interface OpaqueView {
  seq: number;
  ts: string;
  origin: string;
  kind: string;
}

export interface ArchivedView {
  seq: number;
  ts: string;
  reason: "idle" | "requested";
  snapshotSeq?: number;
}

/** An in-flight streaming buffer for one ref (finalized event pending). */
export interface LiveDeltaView {
  ref: string;
  kind: "text" | "reasoning" | "tool_input";
  runId: string;
  attempt: number;
  /** Chunks assembled in `idx` order (gaps allowed). */
  text: string;
  chunks: ReadonlyArray<{ idx: number; text: string }>;
  lastTs: string;
}

/** Partial usage counters as streamed mid-run (zod `.partial()` output). */
export type PartialRunUsage = { [K in keyof RunUsage]?: RunUsage[K] | undefined };

/** Best-effort live usage per run (`ref` = runId); `run_finished` wins. */
export interface LiveUsageView {
  runId: string;
  attempt: number;
  usage: PartialRunUsage;
  lastIdx: number;
  lastTs: string;
}

export interface DriftInfo {
  kind: "gap" | "missing_join_snapshot";
  /** The seq the reducer expected next (or the promised join snapshot's seq). */
  expectedSeq: number;
  /** The seq that actually arrived. */
  gotSeq: number;
  eventType: EventType;
  ts: string;
}

export type JoinState = { mode: "replay" } | { mode: "snapshot"; seq: number; complete: boolean };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TimelineState {
  /** Established by the first applied event; mismatching records are rejected. */
  entityId: string | null;
  spawned: EntitySpawnedEvent["payload"] | null;
  /** Highest seq applied so far (-1 = pristine). Dedup floor (0001:A6). */
  appliedThroughSeq: number;
  join: JoinState;
  /** Latest `state_snapshot` payload.state (opaque entity state). */
  entityState: JsonValue | null;
  entityStateSeq: number | null;
  /** True once a `historyHole` snapshot was crossed (0001:D3 recovery). */
  historyHole: boolean;
  /** First drift observed (0001:D3: a gap is drift). Duplicates are NOT drift. */
  drift: DriftInfo | null;
  driftCount: number;
  /** 0001:A6 same-seq readmissions dropped. */
  duplicatesDropped: number;
  /** Records with seq < the fast-join target skipped during join. */
  skippedPreJoin: number;
  /** Records for a different entityId (never applied). */
  rejectedRecords: number;
  /** Delta chunks dropped (late for a finalized ref, or stale attempt). */
  deltasDropped: number;

  runs: RunView[];
  messages: MessageView[];
  toolCalls: ToolCallView[];
  reasoning: ReasoningView[];
  children: ChildView[];
  controls: ControlView[];
  errors: ErrorView[];
  summarizations: SummarizationView[];
  snapshots: SnapshotView[];
  opaques: OpaqueView[];
  archived: ArchivedView | null;
  /** Highest `summarization.replacesThroughSeq` seen (context-fold marker). */
  summarizedThroughSeq: number | null;

  /** In-flight streaming buffers by ref. Finalized event always wins. */
  liveDeltas: Record<string, LiveDeltaView>;
  /** Best-effort live usage by runId. `run_finished` wins. */
  liveUsage: Record<string, LiveUsageView>;
  /** Refs whose finalized event has landed — late deltas drop on sight. */
  finalizedRefs: ReadonlySet<string>;
  lastEventTs: string | null;
}

export interface TimelineReducerOptions {
  /** Fast-join target: the `state_snapshot` seq from the catalog (0001:A7). */
  fromSnapshot?: { seq: number };
}

export function initialTimelineState(opts: TimelineReducerOptions = {}): TimelineState {
  return {
    entityId: null,
    spawned: null,
    appliedThroughSeq: -1,
    join: opts.fromSnapshot
      ? { mode: "snapshot", seq: opts.fromSnapshot.seq, complete: false }
      : { mode: "replay" },
    entityState: null,
    entityStateSeq: null,
    historyHole: false,
    drift: null,
    driftCount: 0,
    duplicatesDropped: 0,
    skippedPreJoin: 0,
    rejectedRecords: 0,
    deltasDropped: 0,
    runs: [],
    messages: [],
    toolCalls: [],
    reasoning: [],
    children: [],
    controls: [],
    errors: [],
    summarizations: [],
    snapshots: [],
    opaques: [],
    archived: null,
    summarizedThroughSeq: null,
    liveDeltas: {},
    liveUsage: {},
    finalizedRefs: new Set<string>(),
    lastEventTs: null,
  };
}

// ---------------------------------------------------------------------------
// Public apply API (pure: returns a new state)
// ---------------------------------------------------------------------------

export function applyTimelineEvents(
  state: TimelineState,
  events: readonly TimelineEvent[],
): TimelineState {
  if (events.length === 0) return state;
  const d = cloneState(state);
  for (const ev of events) reduceEventInto(d, ev);
  return d;
}

export function applyTimelineEvent(state: TimelineState, event: TimelineEvent): TimelineState {
  return applyTimelineEvents(state, [event]);
}

export function applyDeltaRecords(
  state: TimelineState,
  deltas: readonly DeltaRecord[],
): TimelineState {
  if (deltas.length === 0) return state;
  const d = cloneState(state);
  for (const delta of deltas) reduceDeltaInto(d, delta);
  return d;
}

export function applyDeltaRecord(state: TimelineState, delta: DeltaRecord): TimelineState {
  return applyDeltaRecords(state, [delta]);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Draft with mutable containers; items stay copy-on-write. */
type Draft = TimelineState & { finalizedRefs: Set<string> };

function cloneState(s: TimelineState): Draft {
  return {
    ...s,
    join: { ...s.join },
    runs: [...s.runs],
    messages: [...s.messages],
    toolCalls: [...s.toolCalls],
    reasoning: [...s.reasoning],
    children: [...s.children],
    controls: [...s.controls],
    errors: [...s.errors],
    summarizations: [...s.summarizations],
    snapshots: [...s.snapshots],
    opaques: [...s.opaques],
    liveDeltas: { ...s.liveDeltas },
    liveUsage: { ...s.liveUsage },
    finalizedRefs: new Set(s.finalizedRefs),
  };
}

function recordDrift(d: Draft, info: DriftInfo): void {
  if (d.drift === null) d.drift = info;
  d.driftCount += 1;
}

/**
 * The finalized event for `ref` has landed: discard the streaming buffer and
 * refuse all future chunks for it (finalized always wins).
 */
function finalizeRef(d: Draft, ref: string): void {
  d.finalizedRefs.add(ref);
  if (ref in d.liveDeltas) delete d.liveDeltas[ref];
  if (ref in d.liveUsage) delete d.liveUsage[ref];
}

function reduceEventInto(d: Draft, ev: TimelineEvent): void {
  if (d.entityId === null) {
    d.entityId = ev.entityId;
  } else if (ev.entityId !== d.entityId) {
    d.rejectedRecords += 1;
    return;
  }

  // -- fast-join phase (0001:A7): waiting for the promised snapshot -------------
  if (d.join.mode === "snapshot" && !d.join.complete) {
    const target = d.join.seq;
    if (ev.seq < target) {
      // A byte-offset read may start slightly before the snapshot record.
      d.skippedPreJoin += 1;
      return;
    }
    if (ev.type === "state_snapshot") {
      // Accept seq >= target: snapshot_offset is a monotonic floor (0001:A6 #5).
      d.join = { mode: "snapshot", seq: target, complete: true };
      applyPayload(d, ev);
      d.appliedThroughSeq = ev.seq;
      d.lastEventTs = ev.ts;
      return;
    }
    // The promised snapshot is missing — loud drift, then resync so the UI
    // still shows the live tail.
    recordDrift(d, {
      kind: "missing_join_snapshot",
      expectedSeq: target,
      gotSeq: ev.seq,
      eventType: ev.type,
      ts: ev.ts,
    });
    d.join = { mode: "snapshot", seq: target, complete: true };
    applyPayload(d, ev);
    d.appliedThroughSeq = ev.seq;
    d.lastEventTs = ev.ts;
    return;
  }

  // -- 0001:A6 idempotency: same-seq readmission is a silent no-op --------------
  if (ev.seq <= d.appliedThroughSeq) {
    d.duplicatesDropped += 1;
    return;
  }

  const expected = d.appliedThroughSeq + 1;
  if (ev.seq > expected) {
    if (ev.type === "state_snapshot" && ev.payload.historyHole === true) {
      // Sanctioned jump across a 0001:D3 recovery hole — not drift.
      d.historyHole = true;
    } else {
      recordDrift(d, {
        kind: "gap",
        expectedSeq: expected,
        gotSeq: ev.seq,
        eventType: ev.type,
        ts: ev.ts,
      });
    }
  }
  applyPayload(d, ev);
  d.appliedThroughSeq = ev.seq;
  d.lastEventTs = ev.ts;
}

function applyPayload(d: Draft, ev: TimelineEvent): void {
  switch (ev.type) {
    case "entity_spawned": {
      d.spawned = ev.payload;
      break;
    }
    case "run_started": {
      const p = ev.payload;
      const i = d.runs.findIndex((r) => r.runId === p.runId);
      const view: RunView = {
        ...(i >= 0 ? d.runs[i]! : {}),
        runId: p.runId,
        startedSeq: ev.seq,
        ts: ev.ts,
        wake: p.wake,
        harness: p.harness,
        ...(p.model !== undefined ? { model: p.model } : {}),
        ...(p.detail !== undefined ? { detail: p.detail } : {}),
      };
      if (i >= 0) d.runs[i] = view;
      else d.runs.push(view);
      break;
    }
    case "message": {
      const p = ev.payload;
      d.messages.push({
        id: p.id,
        seq: ev.seq,
        ts: ev.ts,
        role: p.role,
        content: p.content,
        ...(p.runId !== undefined ? { runId: p.runId } : {}),
        ...(p.from !== undefined ? { from: p.from } : {}),
      });
      finalizeRef(d, p.id);
      break;
    }
    case "tool_call": {
      const p = ev.payload;
      const i = d.toolCalls.findIndex((t) => t.toolUseId === p.toolUseId);
      const base = i >= 0 ? d.toolCalls[i]! : undefined;
      const view: ToolCallView = {
        ...(base ?? {}),
        toolUseId: p.toolUseId,
        runId: p.runId,
        name: p.name,
        callSeq: ev.seq,
        callTs: ev.ts,
        input: p.input,
      };
      if (i >= 0) d.toolCalls[i] = view;
      else d.toolCalls.push(view);
      finalizeRef(d, p.toolUseId);
      break;
    }
    case "tool_result": {
      const p = ev.payload;
      const i = d.toolCalls.findIndex((t) => t.toolUseId === p.toolUseId);
      const base = i >= 0 ? d.toolCalls[i]! : undefined;
      const view: ToolCallView = {
        ...(base ?? {}),
        toolUseId: p.toolUseId,
        runId: p.runId,
        ...(p.name !== undefined
          ? { name: p.name }
          : base?.name !== undefined
            ? { name: base.name }
            : {}),
        resultSeq: ev.seq,
        resultTs: ev.ts,
        result: {
          content: p.content,
          ...(p.detail !== undefined ? { detail: p.detail } : {}),
          isError: p.isError,
        },
      };
      if (i >= 0) d.toolCalls[i] = view;
      else d.toolCalls.push(view);
      break;
    }
    case "reasoning": {
      const p = ev.payload;
      d.reasoning.push({
        id: p.id,
        seq: ev.seq,
        ts: ev.ts,
        text: p.text,
        ...(p.runId !== undefined ? { runId: p.runId } : {}),
        ...(p.encrypted !== undefined ? { encrypted: p.encrypted } : {}),
      });
      finalizeRef(d, p.id);
      break;
    }
    case "state_snapshot": {
      const p = ev.payload;
      d.entityState = p.state;
      d.entityStateSeq = ev.seq;
      if (p.historyHole === true) d.historyHole = true;
      d.snapshots.push({
        seq: ev.seq,
        ts: ev.ts,
        reason: p.reason,
        ...(p.historyHole !== undefined ? { historyHole: p.historyHole } : {}),
      });
      break;
    }
    case "summarization": {
      const p = ev.payload;
      d.summarizations.push({
        seq: ev.seq,
        ts: ev.ts,
        summary: p.summary,
        replacesThroughSeq: p.replacesThroughSeq,
        ...(p.runId !== undefined ? { runId: p.runId } : {}),
      });
      d.summarizedThroughSeq = Math.max(d.summarizedThroughSeq ?? -1, p.replacesThroughSeq);
      break;
    }
    case "control": {
      const p = ev.payload;
      d.controls.push({
        seq: ev.seq,
        ts: ev.ts,
        verb: p.verb,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
        ...(p.from !== undefined ? { from: p.from } : {}),
      });
      break;
    }
    case "error": {
      const p = ev.payload;
      d.errors.push({
        seq: ev.seq,
        ts: ev.ts,
        message: p.message,
        source: p.source,
        ...(p.runId !== undefined ? { runId: p.runId } : {}),
        ...(p.code !== undefined ? { code: p.code } : {}),
        ...(p.detail !== undefined ? { detail: p.detail } : {}),
      });
      break;
    }
    case "run_finished": {
      const p = ev.payload;
      const i = d.runs.findIndex((r) => r.runId === p.runId);
      const base = i >= 0 ? d.runs[i]! : undefined;
      const view: RunView = {
        ...(base ?? {}),
        runId: p.runId,
        finishedSeq: ev.seq,
        outcome: p.outcome,
        usage: p.usage,
        ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
        ...(p.detail !== undefined ? { detail: p.detail } : {}),
      };
      if (i >= 0) d.runs[i] = view;
      else d.runs.push(view);
      // The run's authoritative usage has landed; live counters are stale.
      finalizeRef(d, p.runId);
      // Sweep never-finalized trailing partials of this run (0001:D5 loss window).
      for (const [ref, entry] of Object.entries(d.liveDeltas)) {
        if (entry.runId === p.runId) delete d.liveDeltas[ref];
      }
      for (const [ref, entry] of Object.entries(d.liveUsage)) {
        if (entry.runId === p.runId) delete d.liveUsage[ref];
      }
      break;
    }
    case "child_spawned": {
      const p = ev.payload;
      const i = d.children.findIndex((c) => c.childId === p.childId);
      const base = i >= 0 ? d.children[i]! : undefined;
      const view: ChildView = {
        ...(base ?? {}),
        childId: p.childId,
        childType: p.childType,
        spawnedSeq: ev.seq,
        ...(p.runId !== undefined ? { runId: p.runId } : {}),
        ...(p.toolUseId !== undefined ? { toolUseId: p.toolUseId } : {}),
      };
      if (i >= 0) d.children[i] = view;
      else d.children.push(view);
      break;
    }
    case "child_finished": {
      const p = ev.payload;
      const i = d.children.findIndex((c) => c.childId === p.childId);
      const base = i >= 0 ? d.children[i]! : undefined;
      const view: ChildView = {
        ...(base ?? {}),
        childId: p.childId,
        finishedSeq: ev.seq,
        outcome: p.outcome,
        ...(p.result !== undefined ? { result: p.result } : {}),
      };
      if (i >= 0) d.children[i] = view;
      else d.children.push(view);
      break;
    }
    case "archived": {
      const p = ev.payload;
      d.archived = {
        seq: ev.seq,
        ts: ev.ts,
        reason: p.reason,
        ...(p.snapshotSeq !== undefined ? { snapshotSeq: p.snapshotSeq } : {}),
      };
      break;
    }
    case "opaque": {
      const p = ev.payload;
      d.opaques.push({ seq: ev.seq, ts: ev.ts, origin: p.origin, kind: p.kind });
      break;
    }
    default: {
      // Compile-time exhaustiveness — a new frozen event type must be handled.
      const _never: never = ev;
      void _never;
    }
  }
}

function reduceDeltaInto(d: Draft, delta: DeltaRecord): void {
  // entityId is established by the timeline, never by a delta; a delta for a
  // different entity is rejected, one arriving before any timeline event is
  // accepted (live UIs may connect to /deltas first).
  if (d.entityId !== null && delta.entityId !== d.entityId) {
    d.rejectedRecords += 1;
    return;
  }
  // Finalized always wins: late chunks for a finalized ref drop on sight.
  // The run's own id is a finalized ref once `run_finished` lands, so a
  // straggler chunk from an already-finished run (any ref) is equally stale.
  if (d.finalizedRefs.has(delta.ref) || d.finalizedRefs.has(delta.runId)) {
    d.deltasDropped += 1;
    return;
  }
  const attempt = delta.attempt ?? 0;

  if (delta.kind === "usage") {
    const cur = d.liveUsage[delta.ref];
    if (cur !== undefined && attempt < cur.attempt) {
      d.deltasDropped += 1;
      return;
    }
    if (cur === undefined || attempt > cur.attempt) {
      d.liveUsage[delta.ref] = {
        runId: delta.runId,
        attempt,
        usage: { ...delta.usage },
        lastIdx: delta.idx,
        lastTs: delta.ts,
      };
    } else {
      d.liveUsage[delta.ref] = {
        ...cur,
        usage: { ...cur.usage, ...delta.usage },
        lastIdx: Math.max(cur.lastIdx, delta.idx),
        lastTs: delta.ts,
      };
    }
    return;
  }

  // text / reasoning / tool_input — per-ref chunk assembly in idx order.
  const cur = d.liveDeltas[delta.ref];
  if (cur !== undefined && attempt < cur.attempt) {
    d.deltasDropped += 1; // stale attempt straggler (0001:T7.4)
    return;
  }
  if (cur === undefined || attempt > cur.attempt) {
    // New ref, or a retry attempt superseding the previous buffer.
    d.liveDeltas[delta.ref] = {
      ref: delta.ref,
      kind: delta.kind,
      runId: delta.runId,
      attempt,
      chunks: [{ idx: delta.idx, text: delta.text }],
      text: delta.text,
      lastTs: delta.ts,
    };
    return;
  }
  if (cur.chunks.some((c) => c.idx === delta.idx)) {
    d.deltasDropped += 1; // duplicate chunk — first wins
    return;
  }
  const chunks = [...cur.chunks, { idx: delta.idx, text: delta.text }].sort(
    (a, b) => a.idx - b.idx,
  );
  d.liveDeltas[delta.ref] = {
    ...cur,
    chunks,
    text: chunks.map((c) => c.text).join(""),
    lastTs: delta.ts,
  };
}
