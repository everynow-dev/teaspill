/**
 * 0001:T2.2 — Projection outbox + idempotent append (0001:D3, exactly).
 *
 * `DurableStreamsProjectionOutbox` is the REAL implementation of the
 * `ProjectionOutbox` seam 0001:T2.1 defined in ./agent-seams.ts (the stub
 * `InMemoryProjectionOutbox` stays there for the 0001:T2.1 tests). It is the ONLY
 * seq allocator in the system (0001:A1) and the only writer of the timeline
 * stream.
 *
 * ## Producer protocol (extracted from the pinned server source)
 *
 * Read from `../electric/packages/durable-streams-rust/src/handlers.rs`
 * (`parse_producer_headers`, `validate_producer`, `handle_append_inner`,
 * `handle_create`) — the exact source of the deployed image
 * `electricax/durable-streams-server-rust:0.1.4` (that checkout's
 * `package.json` version IS 0.1.4). The root PROTOCOL.md is absent from the
 * checkout; the server source is authoritative for behavior. Semantics:
 *
 * - An append POST may carry `Producer-Id` + `Producer-Epoch` +
 *   `Producer-Seq` (all three or none; 400 otherwise). **`Producer-Seq` is
 *   per-REQUEST, not per-record** — a JSON append body `[a,b,c]` consumes ONE
 *   producer seq. The outbox therefore appends **one event per POST** so that
 *   `Producer-Seq == canonical seq` holds exactly (0001:D3's `(entityId, seq)`
 *   dedup key; addressing.md §7).
 * - Validation per `validate_producer` (C4): unknown producer → seq MUST be 0
 *   (else 409 gap, `Producer-Expected-Seq: 0`); same epoch → `seq <=
 *   last_seq` is a **duplicate** (204 no-op, echoes `Producer-Seq:
 *   <last_seq>`), `seq == last_seq + 1` is accepted (200), anything else is a
 *   **gap** (409 + `Producer-Expected-Seq`/`Producer-Received-Seq`); a lower
 *   epoch → 403 stale epoch (+ current `Producer-Epoch`); a HIGHER epoch must
 *   restart at seq 0 (else 400 "new producer epoch must start at seq 0").
 * - Streams must be PUT-created before the first append (404 otherwise, C3).
 *   PUT create: 201 new, 200 idempotent re-create (same config), 409 when the
 *   config differs.
 * - Appends to a closed stream → 409 with `Stream-Closed: true`.
 * - Ack is post-WAL-fsync, but producer dedup state persistence is
 *   DEBOUNCED to the checkpoint cadence (handlers.rs "Producer/access
 *   updates are debounced (documented crash window)") — a *server* crash
 *   inside that window can readmit an already-acked append on retry. Events
 *   carry their canonical `seq` in the JSON body, so readers dedup
 *   deterministically (0001:T5.2 reducer rule: same seq ⇒ same event) and the
 *   0001:T5.3 reconciler can detect/verify. No client-side action can close this;
 *   it is noted here so nobody assumes the stream is duplicate-free under
 *   server crashes.
 *
 * ## Why not `@durable-streams/client`'s `IdempotentProducer`
 *
 * The pinned client (0.2.6 — the exact version the upstream workspace pairs
 * and conformance-tests against this server source) offers an
 * `IdempotentProducer`, but it is SESSION-scoped: it owns an in-memory
 * `nextSeq` starting at 0 per instance, assigns one producer seq per
 * *batch*, and its `autoClaim` bumps the epoch (resetting seq to 0) on 403.
 * That gives exactly-once within one process session — NOT the persistent
 * `(entityId, canonicalSeq)` dedup 0001:D3 requires across process restarts and
 * Restate retries. The low-level `DurableStream.append` in 0.2.6 declares
 * producer fields on `AppendOptions` but never sends them (dead options).
 * So this module performs the producer append itself (one small POST per
 * event with explicit headers — the thin mapping PLAN 0001:T2.2 anticipated),
 * importing the pinned client's header constants to stay anchored to the
 * protocol lib; readers (0001:T5.2, integration tests) use the client fully.
 *
 * ## Flush protocol (0001:D3: confirm-then-trim, in-order replay)
 *
 * 1. Read the pending outbox + `outboxConfirmedSeq` from K/V. Empty → done.
 * 2. Pre-validate: pending is seq-contiguous ascending (a hole here is
 *    internal corruption → `OutboxDriftError` BEFORE any I/O).
 * 3. ONE `ctx.run` step appends every pending event IN ORDER from the first
 *    unconfirmed: accepted and duplicate outcomes both mean "on the stream";
 *    404 → PUT-create (C3) then retry the append once; gap / stale-epoch /
 *    closed → `OutboxDriftError` (drift is the 0001:T5.3 reconciler's job — the
 *    outbox never papers over it). The closure honors `ctx.runAbortSignal`
 *    (0001:A4 zombie discipline). A transient failure mid-loop throws out of the
 *    `ctx.run`; the retried attempt re-runs the loop from pending[0] and the
 *    already-appended prefix dedups as duplicates — this is exactly the
 *    "replay IN ORDER from the first unconfirmed" C4 requirement, and it is
 *    why the pending array is never partially trimmed.
 * 4. Only after the append step commits: trim the outbox to `[]` and set
 *    `outboxConfirmedSeq` (the cheap last-confirmed tracker 0001:T5.3 reads via
 *    the catalog).
 * 5. Upsert catalog `head_seq` + `status` in a second `ctx.run` (0001:D1: catalog
 *    written only via ctx.run). `head_seq` in the catalog is the last
 *    CONFIRMED seq — updated at trim time, per PLAN 0001:T5.3's anticipate.
 *
 * Crash matrix (all covered by property tests):
 * - crash mid-append-loop → retry replays from pending[0]; prefix dedups.
 * - crash after appends, before the `ctx.run` result journals → same as
 *   above (the whole closure re-runs; every append dedups).
 * - crash after the `ctx.run` journals, before/among the trim K/V writes →
 *   Restate replays the journaled result and re-executes the deterministic
 *   trim; no re-append happens (completed `ctx.run` never re-executes,
 *   SPIKE §e-1).
 * - crash after trim, before the catalog step → catalog lags by one flush;
 *   the retried invocation re-runs the catalog upsert (idempotent, and
 *   monotonic via GREATEST in the writer); the reconciler (0001:T5.3) treats
 *   catalog `head_seq` as a floor, not an exact match.
 *
 * ## Epoch + affine offset (0001:A9, implemented by 0002:T2.1)
 *
 * The producer mapping is the AFFINE map
 *
 *     Producer-Seq = canonicalSeq − outboxProducerSeqOffset
 *
 * with `Producer-Epoch` read from K/V `outboxProducerEpoch` and the offset
 * from K/V `outboxProducerSeqOffset` (both absent ⇒ 0). Normal operation is
 * epoch 0 / offset 0 ⇒ the identity `Producer-Seq == canonicalSeq`
 * (0001:A1 unchanged, addressing.md §7). Both values change ONLY in the
 * deliberate post-catastrophic reset (`handleReconcileRecovery`, below): at
 * canonical seq N on a genuinely lost/fenced stream the agent object bumps
 * `epoch = E+1`, sets `offset = N`, and stages a
 * `state_snapshot(recovery, historyHole: true)` at canonical seq N — which
 * therefore appends at `Producer-Seq 0` under the new epoch (satisfying the
 * server's "a new epoch must start at seq 0" rule) while the canonical seq
 * keeps counting gaplessly (0001:A1). Later events append at `seq − N`.
 * Readers/dedup/context are entirely canonical-seq based (0001:A6#2):
 * epoch+offset never appear in any event and are invisible above the outbox.
 *
 * The reset is REQUESTED by the 0001:T5.3 reconciler (`driveRecovery`) but
 * EXECUTED here, inside the agent object's own exclusive handler — the
 * single-writer owns its K/V; the reconciler never mutates outbox state
 * directly. `OutboxDriftError` carries a structured `detail` so the recovery
 * handler can distinguish the drift classes (and pick an epoch above the
 * server's on a fence) without parsing messages.
 */

import * as restate from "@restatedev/restate-sdk";
import {
  PRODUCER_EPOCH_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
  PRODUCER_SEQ_HEADER,
  STREAM_CLOSED_HEADER,
  STREAM_OFFSET_HEADER,
} from "@durable-streams/client";
import type { JsonValue, RunUsage, TimelineEvent, TimelineEventInit } from "@teaspill/schema";
import { checkSeqContiguity, finalizeEvent } from "@teaspill/schema";
import { selectContextEvents } from "@teaspill/harness-native";
import type {
  AgentRuntimeCtx,
  AgentSharedRuntimeCtx,
  EntityStatus,
} from "./agent-runtime.js";
import { AGENT_KV, ZERO_RUN_USAGE } from "./agent-runtime.js";
import type { OutboxFlushResult, ProjectionOutbox } from "./agent-seams.js";
import { parseEntityUrlLite } from "./agent-seams.js";
import { boundArchiveSnapshotState, type ArchiveSnapshotState } from "./archive-snapshot.js";
// Type-only (erased at runtime — no import cycle): the reconciler seam shapes
// these handlers implement.
import type { EntityProbe, FlushDriveOutcome } from "./reconciler.js";

// ---------------------------------------------------------------------------
// K/V keys owned by this module (additive to AGENT_KV; same object namespace)
// ---------------------------------------------------------------------------

export const OUTBOX_KV = {
  /**
   * `number` — seq of the last event CONFIRMED onto the timeline stream
   * (trimmed from the outbox). Absent ⇒ nothing ever confirmed (or K/V was
   * cleared by archive, 0001:T8.1 — flush recovers it from append outcomes).
   * This is the cheap "last-confirmed-seq tracked at trim time" the 0001:T5.3
   * drift reconciler compares against the catalog/stream (PLAN 0001:T5.3).
   */
  confirmedSeq: "outboxConfirmedSeq",
  /**
   * `number` — durable-streams `Producer-Epoch` (absent ⇒ 0). Constant in
   * normal operation; bumped ONLY by the catastrophic reset
   * (`handleReconcileRecovery`, 0001:A9 / 0002:T2.1 — always together with
   * `producerSeqOffset`).
   */
  producerEpoch: "outboxProducerEpoch",
  /**
   * `number` — the affine producer-seq offset (absent ⇒ 0):
   * `Producer-Seq = canonicalSeq − offset` (0001:A9). 0 in normal operation
   * (identity, 0001:A1). Set to the recovery snapshot's canonical seq by the
   * catastrophic reset so the new epoch starts at `Producer-Seq 0` while the
   * canonical seq stays gapless. Written ONLY by `handleReconcileRecovery`
   * (and restored by resurrection) — never by the reconciler (single-writer
   * owns the K/V).
   */
  producerSeqOffset: "outboxProducerSeqOffset",
  /**
   * `string` — the last-known durable-streams `Stream-Next-Offset` (opaque
   * read offset marking the current stream END). Updated at flush time from
   * the final accepted append's returned offset (0001:T8.1 byte-offset capture).
   * Used to compute the read offset at which a `state_snapshot` record
   * BEGINS (= the stream end just before that record is appended) so 0001:T5.2 can
   * seek to the snapshot without scanning from 0. Absent ⇒ unknown (fresh
   * stream / never captured); the snapshot-offset capture is best-effort and
   * simply skips when the begin-offset is unknown (see flush). NOT read for
   * control flow — a pure seek hint.
   */
  streamOffset: "outboxStreamOffset",
} as const;

// ---------------------------------------------------------------------------
// Addressing (https://teaspill.everynow.dev/reference/addressing) — local until they land in schema
// ---------------------------------------------------------------------------

/** Timeline stream server path for an entity url (addressing §4.1). */
export function timelineStreamPath(entityUrl: string): string {
  const parsed = parseEntityUrlLite(entityUrl);
  if (!parsed) throw new Error(`not a canonical entity url: ${JSON.stringify(entityUrl)}`);
  return `/t/${parsed.tenant}/agents/${parsed.type}/${parsed.id}/timeline`;
}

/** Producer-Id for an entity's timeline outbox == the entity url (addressing §7). */
export function timelineProducerId(entityUrl: string): string {
  if (!parseEntityUrlLite(entityUrl)) {
    throw new Error(`not a canonical entity url: ${JSON.stringify(entityUrl)}`);
  }
  return entityUrl;
}

export const TIMELINE_CONTENT_TYPE = "application/json";

// ---------------------------------------------------------------------------
// Transport seam (real HTTP below; faithful fake in ./testing for the
// property tests — both speak the exact server outcome vocabulary)
// ---------------------------------------------------------------------------

export interface ProducerRef {
  id: string;
  epoch: number;
  seq: number;
}

/** The server's append verdicts, 1:1 with `handlers.rs` `ProducerOutcome` + the two request-level rejections. */
export type ProducerAppendOutcome =
  /** Appended; `nextOffset` (server `Stream-Next-Offset`) is the read offset AFTER this record, when the server reported it. */
  | { kind: "accepted"; nextOffset?: string }
  /** `seq <= last_seq` for this (producer, epoch): idempotent no-op (204). */
  | { kind: "duplicate"; lastSeq: number; nextOffset?: string }
  /** Out-of-order seq after a gap: rejected, server names the seq it wants (409). */
  | { kind: "gap"; expectedSeq: number; receivedSeq: number }
  /** Epoch lower than the server's current for this producer: fenced (403). */
  | { kind: "stale_epoch"; currentEpoch: number }
  /** A new (higher) epoch must start at seq 0 (400). */
  | { kind: "bad_epoch_start" }
  /** Stream was never PUT-created, or was deleted (404) — C3. */
  | { kind: "stream_not_found" }
  /** Stream is closed; no further appends (409 + Stream-Closed). */
  | { kind: "closed" };

export interface TimelineStreamTransport {
  /** PUT-create (C3). Idempotent: "exists" when already created with the same config. Throws on config conflict / transport failure. */
  createStream(path: string, opts?: { signal?: AbortSignal }): Promise<"created" | "exists">;
  /**
   * POST one event (pre-serialized JSON) with explicit producer headers.
   * Returns the server's verdict; throws only on transport/unexpected
   * failures (which Restate retries).
   */
  appendEvent(
    path: string,
    eventJson: string,
    producer: ProducerRef,
    opts?: { signal?: AbortSignal },
  ): Promise<ProducerAppendOutcome>;
}

/**
 * Real HTTP transport against a durable-streams server (0.1.4 protocol).
 * Header names come from the pinned `@durable-streams/client` (0.2.6 — the
 * version upstream pairs with this server; see module header). One event per
 * POST keeps `Producer-Seq == canonical seq` (producer seq is per-request).
 */
export class HttpTimelineStreamTransport implements TimelineStreamTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(opts: {
    /** durable-streams server base url, e.g. `http://durable-streams:4437`. */
    baseUrl: string;
    fetch?: typeof fetch;
    /** Extra headers (e.g. auth) merged into every request. */
    headers?: Record<string, string>;
  }) {
    this.#baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.#fetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.#headers = opts.headers ?? {};
  }

  async createStream(path: string, opts?: { signal?: AbortSignal }): Promise<"created" | "exists"> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "PUT",
      headers: { ...this.#headers, "content-type": TIMELINE_CONTENT_TYPE },
      ...(opts?.signal && { signal: opts.signal }),
    });
    if (res.status === 201) return "created";
    if (res.status === 200) return "exists"; // idempotent re-create, same config
    const body = await res.text().catch(() => "");
    throw new Error(`durable-streams PUT ${path} failed: ${res.status} ${body}`);
  }

  async appendEvent(
    path: string,
    eventJson: string,
    producer: ProducerRef,
    opts?: { signal?: AbortSignal },
  ): Promise<ProducerAppendOutcome> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...this.#headers,
        "content-type": TIMELINE_CONTENT_TYPE,
        [PRODUCER_ID_HEADER]: producer.id,
        [PRODUCER_EPOCH_HEADER]: String(producer.epoch),
        [PRODUCER_SEQ_HEADER]: String(producer.seq),
      },
      // JSON streams take an array body; each element is one record
      // (encode_wire). One-element array = one record per producer seq.
      body: `[${eventJson}]`,
      ...(opts?.signal && { signal: opts.signal }),
    });
    // Drain the (empty/small) body so keep-alive sockets are reusable.
    const bodyText = await res.text().catch(() => "");
    const nextOffset = res.headers.get(STREAM_OFFSET_HEADER);
    switch (res.status) {
      case 200:
        return { kind: "accepted", ...(nextOffset !== null && { nextOffset }) };
      case 204: {
        const lastSeq = Number(res.headers.get(PRODUCER_SEQ_HEADER) ?? producer.seq);
        return { kind: "duplicate", lastSeq, ...(nextOffset !== null && { nextOffset }) };
      }
      case 409: {
        if (res.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === "true") {
          return { kind: "closed" };
        }
        const expected = res.headers.get(PRODUCER_EXPECTED_SEQ_HEADER);
        if (expected !== null) {
          const received = res.headers.get(PRODUCER_RECEIVED_SEQ_HEADER);
          return {
            kind: "gap",
            expectedSeq: Number(expected),
            receivedSeq: received !== null ? Number(received) : producer.seq,
          };
        }
        throw new Error(`durable-streams POST ${path}: unexpected 409: ${bodyText}`);
      }
      case 403: {
        const current = res.headers.get(PRODUCER_EPOCH_HEADER);
        return { kind: "stale_epoch", currentEpoch: current !== null ? Number(current) : 0 };
      }
      case 400: {
        if (bodyText.includes("epoch must start at seq 0")) return { kind: "bad_epoch_start" };
        throw new Error(`durable-streams POST ${path}: 400 ${bodyText}`);
      }
      case 404:
        return { kind: "stream_not_found" };
      default:
        throw new Error(`durable-streams POST ${path} failed: ${res.status} ${bodyText}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Catalog seam (0001:D1: catalog written only from inside handlers via ctx.run)
// ---------------------------------------------------------------------------

export interface OutboxCatalogUpsert {
  entityId: string;
  /** Last CONFIRMED seq (trim-time value — the 0001:T5.3 comparison anchor). */
  headSeq: number;
  status: EntityStatus;
}

export interface OutboxCatalogSnapshotUpsert {
  entityId: string;
  /** Canonical seq of the `state_snapshot` event (catalog `snapshot_offset`; 0001:A7). */
  snapshotSeq: number;
  /**
   * Opaque durable-streams read offset at which that snapshot record BEGINS
   * (catalog `snapshot_stream_offset`; 0001:T8.1 / 0001:T5.2 fast-join seek hint), when
   * the outbox could determine it. Omitted when unknown.
   */
  snapshotStreamOffset?: string;
}

/** Implemented for real over Drizzle in ./projection-catalog.ts. */
export interface OutboxCatalog {
  upsertHead(upsert: OutboxCatalogUpsert): Promise<void>;
  /**
   * Record the latest `state_snapshot`'s seq + (when known) its stream begin
   * offset (0001:T8.1). Monotonic (GREATEST on seq) in the real writer. Optional so
   * pre-0001:T8.1 catalog writers / test fakes need not implement it — the outbox
   * only calls it when a flush actually appended a `state_snapshot`.
   */
  upsertSnapshot?(upsert: OutboxCatalogSnapshotUpsert): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Structured classification of a drift condition, attached to
 * `OutboxDriftError` so the recovery handler (same process, agent object)
 * can react without parsing messages. `serverEpoch` is present for
 * `stale_epoch` — the reset must pick an epoch ABOVE it. NOTE: the detail
 * survives only in-process; across a Restate call boundary only the message
 * travels (which is fine — recovery runs inside the agent object).
 */
export interface OutboxDriftDetail {
  kind:
    | "pending_gap" // pending outbox internally non-contiguous (K/V corruption)
    | "confirmed_mismatch" // pending head skips past the confirmed seq (K/V corruption)
    | "offset_underflow" // pending seq below the current epoch's origin (K/V corruption)
    | "producer_gap" // server tail behind the trimmed outbox (stream loss / rollback)
    | "stale_epoch" // fenced: server holds a higher epoch
    | "bad_epoch_start" // new epoch not starting at Producer-Seq 0
    | "closed"; // stream closed — no appends possible at any epoch
  /** Server's current epoch (present for `stale_epoch`). */
  serverEpoch?: number;
}

/**
 * Projection drift: the stream's producer state and the entity's K/V
 * disagree in a way in-order replay cannot fix (seq gap below the first
 * unconfirmed event, fenced epoch, closed stream). Terminal so Restate does
 * NOT hot-loop the wake; the outbox stays intact (K/V commits are
 * unaffected), every later flush re-surfaces the error, and repair belongs
 * to the 0001:T5.3 reconciler (0001:D3 catastrophic path: state_snapshot + epoch bump
 * + producer-seq restart, executed by `handleReconcileRecovery`).
 */
export class OutboxDriftError extends restate.TerminalError {
  readonly detail: OutboxDriftDetail | undefined;
  constructor(message: string, detail?: OutboxDriftDetail) {
    super(message, { errorCode: 409 });
    this.name = "OutboxDriftError";
    this.detail = detail;
  }
}

/** A single event (or the pending outbox value) exceeds the journal budget (0001:A4/0001:R4). */
export class OutboxBudgetError extends restate.TerminalError {
  constructor(message: string) {
    super(message, { errorCode: 413 });
    this.name = "OutboxBudgetError";
  }
}

// ---------------------------------------------------------------------------
// The real ProjectionOutbox (0001:T2.2)
// ---------------------------------------------------------------------------

/** ~1 MiB — the 0001:A4 journal-entry design budget (SPIKE §b). */
export const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

export interface DurableStreamsOutboxOptions {
  transport: TimelineStreamTransport;
  /** Optional catalog writer; omit in tests / when the catalog is wired elsewhere. */
  catalog?: OutboxCatalog;
  /** Per-event serialized-size ceiling (0001:A4 ~1 MiB journal budget). */
  maxEventBytes?: number;
  /** Serialized pending-outbox K/V value ceiling (same budget; callers chunk, 0001:R4). */
  maxPendingBytes?: number;
}

export class DurableStreamsProjectionOutbox implements ProjectionOutbox {
  readonly #transport: TimelineStreamTransport;
  readonly #catalog: OutboxCatalog | undefined;
  readonly #maxEventBytes: number;
  readonly #maxPendingBytes: number;

  constructor(opts: DurableStreamsOutboxOptions) {
    this.#transport = opts.transport;
    this.#catalog = opts.catalog;
    this.#maxEventBytes = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.#maxPendingBytes = opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  }

  /**
   * THE seq allocator (0001:A1): 0-based gapless from the K/V `seq` counter,
   * atomic with the invocation under single-writer (0001:D3). Pure K/V — no I/O,
   * no clock. Budget assertions run BEFORE any K/V write so a rejected
   * stage allocates nothing.
   */
  async stage(
    ctx: AgentRuntimeCtx,
    entityId: string,
    events: readonly TimelineEventInit[],
  ): Promise<TimelineEvent[]> {
    if (events.length === 0) return [];
    const nextSeq = (await ctx.get<number>(AGENT_KV.seq)) ?? 0;
    const finalized = events.map((init, i) => finalizeEvent(init, { entityId, seq: nextSeq + i }));

    let batchBytes = 0;
    for (const ev of finalized) {
      const bytes = Buffer.byteLength(JSON.stringify(ev), "utf8");
      if (bytes > this.#maxEventBytes) {
        throw new OutboxBudgetError(
          `event seq ${ev.seq} (${ev.type}) serializes to ${bytes} bytes > ${this.#maxEventBytes} ` +
            `(journal budget). Event payloads must be summaries/refs — bulk goes to streams.`,
        );
      }
      batchBytes += bytes;
    }
    const pending = (await ctx.get<TimelineEvent[]>(AGENT_KV.outbox)) ?? [];
    const pendingBytes =
      pending.length === 0 ? 2 : Buffer.byteLength(JSON.stringify(pending), "utf8");
    if (pendingBytes + batchBytes > this.#maxPendingBytes) {
      throw new OutboxBudgetError(
        `staging ${events.length} events (${batchBytes}B) onto a pending outbox of ${pendingBytes}B ` +
          `would exceed the ${this.#maxPendingBytes}B K/V budget. ` +
          `Interleave stage/flush in bounded chunks (commitEventsChunked).`,
      );
    }

    ctx.set(AGENT_KV.seq, nextSeq + events.length);
    ctx.set(AGENT_KV.outbox, [...pending, ...finalized]);
    return finalized;
  }

  /**
   * Drain the pending outbox to the timeline stream: idempotent-producer
   * append inside `ctx.run`, in-order from the first unconfirmed,
   * confirm-then-trim, catalog `head_seq` upsert. See module header for the
   * full protocol + crash matrix.
   */
  async flush(ctx: AgentRuntimeCtx, entityId: string): Promise<OutboxFlushResult> {
    const pending = (await ctx.get<TimelineEvent[]>(AGENT_KV.outbox)) ?? [];
    const confirmedSeq = await ctx.get<number>(OUTBOX_KV.confirmedSeq);
    if (pending.length === 0) {
      return { appended: 0, headSeq: confirmedSeq };
    }

    // Pre-flight invariants (no I/O yet, so failing here loses nothing):
    // the pending array must be seq-contiguous ascending, and must start
    // exactly one past the confirmed head when one is known. A violation is
    // internal corruption, not a retryable condition.
    const first = pending[0]!;
    const contiguity = checkSeqContiguity(pending, { expectedFirstSeq: first.seq });
    if (!contiguity.ok) {
      throw new OutboxDriftError(
        `pending outbox for ${entityId} is not seq-contiguous: expected ${contiguity.expectedSeq} ` +
          `at index ${contiguity.violationAt} — refusing to append (C4 in-order replay would corrupt).`,
        { kind: "pending_gap" },
      );
    }
    if (confirmedSeq !== null && first.seq !== confirmedSeq + 1) {
      throw new OutboxDriftError(
        `pending outbox for ${entityId} starts at seq ${first.seq} but last confirmed is ${confirmedSeq} ` +
          `(expected ${confirmedSeq + 1}).`,
        { kind: "confirmed_mismatch" },
      );
    }

    const epoch = (await ctx.get<number>(OUTBOX_KV.producerEpoch)) ?? 0;
    // 0001:A9 affine map: Producer-Seq = canonicalSeq − offset (0 ⇒ identity, 0001:A1).
    const producerSeqOffset = (await ctx.get<number>(OUTBOX_KV.producerSeqOffset)) ?? 0;
    if (first.seq < producerSeqOffset) {
      throw new OutboxDriftError(
        `pending outbox for ${entityId} starts at seq ${first.seq}, below the epoch-${epoch} producer ` +
          `origin ${producerSeqOffset} — events older than the last reset can never append (K/V corruption).`,
        { kind: "offset_underflow" },
      );
    }
    const priorStreamOffset = await ctx.get<string>(OUTBOX_KV.streamOffset);
    const path = timelineStreamPath(entityId);
    const producerId = timelineProducerId(entityId);
    // ATTEMPT-retirement signal only (0002:T4.2): the flush is the durable
    // record of an interrupt's wind-down — it must survive `runAbortSignal`'s
    // interrupt branch and abort only when the runtime abandons this attempt
    // (zombie discipline, SPIKE §e-3/4). See AgentRuntimeCtx.attemptAbortSignal.
    const signal = ctx.attemptAbortSignal ?? ctx.runAbortSignal;
    const transport = this.#transport;

    // ONE journaled step for the whole (bounded, ≤ chunk-size) batch. The
    // closure is at-least-once (SPIKE §e-2): every re-execution replays the
    // SAME events in the SAME order from pending[0], and the idempotent
    // producer turns the already-appended prefix into duplicate no-ops. The
    // RESULT (append count + captured snapshot offsets + end offset) is
    // journaled once and never re-executed (SPIKE §e-1), so the offset capture
    // is replay-stable.
    //
    // ⚠ DRIFT identity across the journal boundary (0002:T4.3 live finding):
    // drift verdicts must NOT be thrown from INSIDE this closure. Live Restate
    // journals a TerminalError thrown in `ctx.run` and rethrows a
    // RECONSTRUCTED plain TerminalError at the await — the `OutboxDriftError`
    // subclass identity and its `.detail` are lost, so every downstream
    // `instanceof OutboxDriftError` (handleReconcileFlush's drift mapping,
    // handleReconcileRecovery's re-verify) silently stops matching and the
    // reconciler can never route drift to recovery. (Invisible offline: the
    // fakes rethrow the original object.) Instead the closure RETURNS the
    // drift verdict as journaled data and the throw happens OUTSIDE the step —
    // deterministic on replay (derived purely from the journaled result) and
    // identity-preserving. Transient errors still throw from inside (retry).
    const flushOutcome = await ctx.run("outbox-flush", async (): Promise<{
      newlyAppended: number;
      snapshots: { seq: number; offset: string | null }[];
      endOffset: string | null;
      drift?: { message: string; detail: OutboxDriftDetail };
    }> => {
      let newlyAppended = 0;
      let createdOnDemand = false;
      // 0001:T8.1 byte-offset capture: track the stream's current END offset. A
      // `state_snapshot` record BEGINS at the end offset that stood just
      // before its own append, which is exactly the offset a reader seeks to
      // so the snapshot is the first record it sees. `running` advances only
      // on a confirmed (accepted) append's `Stream-Next-Offset`; on a
      // duplicate we leave it unchanged (it may lag the true end — which only
      // ever makes a captured begin-offset EARLIER, never later, so a reader
      // over-reads a few records at worst; the reducer's fast-join seq floor
      // (0001:A6 #5) discards them). `null` ⇒ unknown ⇒ that snapshot's offset is
      // simply not captured (the catalog column stays null; 0001:T5.2 falls back to
      // a seq-only fast-join).
      let running: string | null = priorStreamOffset;
      const snapshots: { seq: number; offset: string | null }[] = [];
      for (const ev of pending) {
        signal.throwIfAborted();
        const offsetBefore = running;
        const eventJson = JSON.stringify(ev);
        const producer: ProducerRef = { id: producerId, epoch, seq: ev.seq - producerSeqOffset };
        let outcome = await transport.appendEvent(path, eventJson, producer, { signal });
        if (outcome.kind === "stream_not_found" && !createdOnDemand) {
          // C3: PUT-create before first append (idempotent; also covers a
          // replayed first flush racing its own earlier create, and the
          // post-reset flush onto a genuinely lost stream).
          await transport.createStream(path, { signal });
          createdOnDemand = true;
          outcome = await transport.appendEvent(path, eventJson, producer, { signal });
        }
        if (ev.type === "state_snapshot") {
          // Record the snapshot SEQ always (the 0001:A7 catalog `snapshot_offset`
          // fast-join floor — vital for a `recovery` snapshot marking a history
          // hole); the byte begin-offset only when known (0001:T8.1 seek hint).
          snapshots.push({ seq: ev.seq, offset: offsetBefore });
        }
        switch (outcome.kind) {
          case "accepted":
            newlyAppended += 1;
            if (outcome.nextOffset !== undefined) running = outcome.nextOffset;
            break;
          case "duplicate":
            // seq <= server's last_seq for this producer/epoch: already on
            // the stream from a previous attempt — exactly the crash-between-
            // append-and-trim replay. No-op, keep going in order (leave
            // `running` unchanged — see the capture note above).
            break;
          case "gap":
            return {
              newlyAppended,
              snapshots,
              endOffset: running,
              drift: {
                message:
                  `producer seq gap for ${entityId}: server expects producer-seq ${outcome.expectedSeq} ` +
                  `(canonical ${outcome.expectedSeq + producerSeqOffset}), outbox replayed ` +
                  `${outcome.receivedSeq} (canonical ${ev.seq}). The stream tail is behind the trimmed ` +
                  `outbox (stream loss / producer-state rollback) — reconciler repair required.`,
                detail: { kind: "producer_gap" },
              },
            };
          case "stale_epoch":
            return {
              newlyAppended,
              snapshots,
              endOffset: running,
              drift: {
                message:
                  `producer epoch ${epoch} for ${entityId} is fenced (server epoch ${outcome.currentEpoch}). ` +
                  `Only the reset path bumps epochs — investigate before writing.`,
                detail: { kind: "stale_epoch", serverEpoch: outcome.currentEpoch },
              },
            };
          case "bad_epoch_start":
            return {
              newlyAppended,
              snapshots,
              endOffset: running,
              drift: {
                message:
                  `producer epoch ${epoch} for ${entityId} is new to the server but the outbox starts at ` +
                  `producer-seq ${ev.seq - producerSeqOffset} (canonical ${ev.seq}; must be 0). ` +
                  `Epoch resets must restart Producer-Seq at 0 (addressing §7).`,
                detail: { kind: "bad_epoch_start" },
              },
            };
          case "closed":
            return {
              newlyAppended,
              snapshots,
              endOffset: running,
              drift: {
                message: `timeline stream for ${entityId} is closed — no further appends are possible.`,
                detail: { kind: "closed" },
              },
            };
          case "stream_not_found":
            throw new Error(
              `timeline stream for ${entityId} still missing after PUT-create — transient, retrying.`,
            );
          default: {
            const exhaustive: never = outcome;
            throw new Error(`unknown append outcome ${JSON.stringify(exhaustive)}`);
          }
        }
      }
      return { newlyAppended, snapshots, endOffset: running };
    });
    if (flushOutcome.drift !== undefined) {
      // Thrown OUTSIDE the journaled step so subclass identity + `.detail`
      // survive to every `instanceof OutboxDriftError` consumer (see the
      // journal-boundary note above). Replay-deterministic: the drift verdict
      // is part of the journaled result.
      throw new OutboxDriftError(flushOutcome.drift.message, flushOutcome.drift.detail);
    }
    const appended = flushOutcome.newlyAppended;

    // Confirm-then-trim (0001:D3): every pending event is now on the stream (the
    // append step above either confirmed all of them or threw).
    const headSeq = pending[pending.length - 1]!.seq;
    ctx.set(AGENT_KV.outbox, []);
    ctx.set(OUTBOX_KV.confirmedSeq, headSeq);
    // Persist the last-known stream end offset for the next flush's capture
    // (only when known — never overwrite a good value with null).
    if (flushOutcome.endOffset !== null) {
      ctx.set(OUTBOX_KV.streamOffset, flushOutcome.endOffset);
    }

    // Catalog head_seq/status upsert alongside (0001:D1: via ctx.run). Runs after
    // trim; a crash in between leaves catalog head_seq lagging (a floor —
    // documented in the crash matrix; 0001:T5.3 compares accordingly).
    if (this.#catalog) {
      const catalog = this.#catalog;
      const status = (await ctx.get<EntityStatus>(AGENT_KV.status)) ?? "active";
      await ctx.run("outbox-catalog", () => catalog.upsertHead({ entityId, headSeq, status }));
      // Latest snapshot's seq (+ begin offset when captured) — 0001:T8.1/0001:T5.2
      // fast-join hint. Only when this flush appended a `state_snapshot`. The
      // SEQ is upserted even when the byte offset is unknown (e.g. the first
      // flush after an epoch reset onto a recreated stream) — the 0001:A6#5
      // seq floor is what fast-join correctness rests on; the byte offset is
      // only a cheaper seek.
      if (catalog.upsertSnapshot && flushOutcome.snapshots.length > 0) {
        const latest = flushOutcome.snapshots[flushOutcome.snapshots.length - 1]!;
        const upsertSnapshot = catalog.upsertSnapshot.bind(catalog);
        await ctx.run("outbox-catalog-snapshot", () =>
          upsertSnapshot({
            entityId,
            snapshotSeq: latest.seq,
            ...(latest.offset !== null && { snapshotStreamOffset: latest.offset }),
          }),
        );
      }
    }

    return { appended, headSeq };
  }
}

// ---------------------------------------------------------------------------
// Reconcile handlers (0002:T2.1 — the 0001:A9 follow-up)
//
// Handler LOGIC for the three agent-object handlers the 0001:T5.3 reconciler's
// `createRestateEntityReconcileClient` targets (wired onto the object in
// ./agent.ts). They live in THIS module because the epoch/offset reset is the
// outbox protocol's own catastrophic path: only the module that owns OUTBOX_KV
// writes it. The critical split (0001:A9): the reconciler DETECTS drift and
// REQUESTS recovery; the agent object (single-writer) EXECUTES it.
// ---------------------------------------------------------------------------

const isoTs = (ms: number): string => new Date(ms).toISOString();

/**
 * `reconcileProbe` — SHARED handler logic (0001:A6#4): the cheap per-entity
 * K/V read the reconciler compares against the catalog. Runs concurrently
 * with a busy exclusive wake (shared handlers see in-flight K/V live, SPIKE
 * §a-2) and MUST stay cheap: a handful of K/V gets, no `ctx.run`, no stream
 * or catalog I/O, nothing that could block behind an exclusive invocation.
 * `null` ⇒ not resident (never spawned, or archived-and-cleared) — the
 * reconciler skips it (the catalog row is the archive-of-record, 0001:D7).
 */
export async function handleReconcileProbe(
  ctx: AgentSharedRuntimeCtx,
): Promise<EntityProbe | null> {
  const seq = await ctx.get<number>(AGENT_KV.seq);
  if (seq === null) return null;
  const status = (await ctx.get<EntityStatus>(AGENT_KV.status)) ?? "idle";
  const confirmedSeq = await ctx.get<number>(OUTBOX_KV.confirmedSeq);
  const pending = (await ctx.get<TimelineEvent[]>(AGENT_KV.outbox)) ?? [];
  return {
    status,
    confirmedSeq,
    pendingCount: pending.length,
    pendingFirstSeq: pending.length > 0 ? pending[0]!.seq : null,
    pendingLastSeq: pending.length > 0 ? pending[pending.length - 1]!.seq : null,
  };
}

/**
 * `reconcileFlush` — EXCLUSIVE handler logic: re-drive this entity's outbox
 * flush (idempotent in-order replay, 0001:T2.2) and map `OutboxDriftError`
 * to the seam's `{ kind: "drift" }` outcome instead of rethrowing — drift is
 * the reconciler's INPUT (it decides the recovery response), not a handler
 * failure. Anything else (transient transport) propagates so Restate retries.
 */
export async function handleReconcileFlush(
  ctx: AgentRuntimeCtx,
  outbox: ProjectionOutbox,
  entityId: string,
): Promise<FlushDriveOutcome> {
  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    // Not resident — nothing staged, nothing to drive. Report the empty flush.
    return { kind: "flushed", headSeq: null, appended: 0 };
  }
  try {
    const result = await outbox.flush(ctx, entityId);
    return { kind: "flushed", headSeq: result.headSeq, appended: result.appended };
  } catch (err) {
    if (err instanceof OutboxDriftError) return { kind: "drift", message: err.message };
    throw err;
  }
}

/** `reconcileRecovery` request body (the reconciler's `driveRecovery` opts). */
export interface ReconcileRecoveryInput {
  /** Human-readable drift cause (the flush's OutboxDriftError message) — for logs/result only. */
  reason: string;
  /**
   * Authorization for the destructive epoch reset (`ReconcilerSpec.allowEpochReset`).
   * `false` ⇒ the handler is a pure no-op returning `gated` (0001:A9's
   * default-off caution) — nothing is written, the alert keeps firing.
   */
  resetEpoch: boolean;
}

export type ReconcileRecoveryResult =
  | {
      performed: false;
      /**
       * - `gated` — `resetEpoch` was false; nothing was touched.
       * - `no-live-state` — entity not resident (never spawned / archived).
       * - `healthy` — the re-verification flush SUCCEEDED (the drift healed
       *   between the reconciler's probe and this handler, or a prior
       *   partially-crashed recovery already converged); no reset needed.
       * - `stream-closed` — the stream is CLOSED: no epoch can ever append,
       *   so a reset can never make progress. Alert-and-hold: nothing is
       *   touched (no per-tick snapshot/epoch churn); the entity stays stable
       *   and stuck until ops reopen/replace the stream.
       * - `failed` — the reset could not be performed (terminal, e.g. the
       *   snapshot event exceeds a size budget); K/V fully restored — the
       *   pending outbox stays intact for a later retry, no hole is stranded.
       */
      reason: "gated" | "no-live-state" | "healthy" | "stream-closed" | "failed";
      message?: string;
    }
  | {
      performed: true;
      /** The new producer epoch (E+1, above the server's on a fence). */
      epoch: number;
      /** The new affine offset == the recovery snapshot's canonical seq. */
      producerSeqOffset: number;
      /** Canonical seq of the `state_snapshot(recovery, historyHole)` event. */
      snapshotSeq: number;
      /**
       * True when the post-reset flush confirmed the snapshot onto the stream.
       * False when it still could not append (a drift arising BETWEEN the
       * verify flush and this one — e.g. the stream closed or was fenced
       * concurrently); the reset state is durable, the snapshot stays pending
       * (the next wake's opening flush retries it), and the reconciler's
       * alert keeps firing until it resolves.
       */
      flushed: boolean;
    };

export interface ReconcileRecoveryDeps {
  outbox: ProjectionOutbox;
  /** Bound for the recovery snapshot state (same knob as the archive snapshot). */
  archiveSnapshotMaxBytes?: number;
  /** Opaque origins retained in the folded context (agent config). */
  contextOpaqueOrigins?: readonly string[];
}

/**
 * `reconcileRecovery` — EXCLUSIVE handler logic: the 0001:D3 catastrophic
 * reset, EXECUTED by the single-writer (0001:A9 split). Steps:
 *
 *  1. Re-verify with a live flush: only a fresh `OutboxDriftError` inside
 *     THIS invocation authorizes the destructive step (the reconciler's
 *     probe→recovery window is not evidence; a healed/converged outbox
 *     returns `healthy`). A CLOSED stream returns `stream-closed` and holds —
 *     no epoch can append to it, so a reset would only churn (a new snapshot
 *     + epoch bump per reconciler tick, forever, none reaching the stream).
 *  2. Fold the stuck pending events into the bounded K/V context (their
 *     content survives via the snapshot state), then DROP them from the
 *     outbox — they are the history hole: in-order replay proved they can
 *     never reach the stream at any epoch, and the recovery snapshot at seq N
 *     asserts complete state as of N (0001:A5), superseding them.
 *  3. Stage `state_snapshot(reason: "recovery", historyHole: true)` at the
 *     next canonical seq N — the canonical counter NEVER resets (0001:A1;
 *     the lost events keep their seqs, inside the hole).
 *  4. THE RESET (0001:A9): epoch = max(stored, serverEpoch)+1, offset = N,
 *     confirmedSeq = N−1 (seqs below N are either on-stream under an old
 *     epoch or inside the hole), and the stale byte-offset hint is cleared
 *     (offsets from the lost stream are meaningless).
 *  5. Flush: the snapshot appends at `Producer-Seq 0` under the new epoch
 *     (404 ⇒ the flush PUT-creates the lost stream first); later events
 *     append at `seq − N`. A flush that STILL drifts (the stream closed or
 *     was fenced between the verify and this append) leaves the reset
 *     durable and reports `flushed: false`.
 *
 * Crash-safety: every K/V write and the flush's append step are journaled on
 * the exclusive invocation; a retried attempt replays them (SPIKE §e-1). A
 * FULLY re-executed recovery (new invocation after an aborted one) converges:
 * its step-1 flush either succeeds against the already-reset state
 * (`healthy`) or re-drives the same pending snapshot as a duplicate no-op.
 * The reset property suite exercises these windows.
 */
export async function handleReconcileRecovery(
  ctx: AgentRuntimeCtx,
  deps: ReconcileRecoveryDeps,
  entityId: string,
  input: ReconcileRecoveryInput,
): Promise<ReconcileRecoveryResult> {
  if ((await ctx.get<number>(AGENT_KV.seq)) === null) {
    return { performed: false, reason: "no-live-state" };
  }
  if (input.resetEpoch !== true) {
    // 0001:A9 gate: alert-only stance. Nothing is read further, nothing written.
    return { performed: false, reason: "gated" };
  }

  // 1. Re-verify inside the single-writer.
  let drift: OutboxDriftError;
  try {
    await deps.outbox.flush(ctx, entityId);
    return { performed: false, reason: "healthy" };
  } catch (err) {
    if (!(err instanceof OutboxDriftError)) throw err; // transient — Restate retries
    drift = err;
  }

  // CLOSED stream: no epoch can ever append to it, so a reset can never make
  // progress — performing one would only churn (a fresh snapshot + epoch bump
  // per reconciler tick, unbounded canonical-seq/epoch inflation, none of it
  // reaching the stream). Alert-and-HOLD instead: touch nothing, report, and
  // keep the entity stable until ops intervene (reopen/replace the stream —
  // at which point the drift re-classifies and recovery proceeds normally).
  if (drift.detail?.kind === "closed") {
    return { performed: false, reason: "stream-closed", message: drift.message };
  }

  try {
    // 2. Fold the doomed pending events into the bounded context (dedup +
    //    re-sort defensively — a corrupted pending value must not wedge the
    //    recovery), then drop them (the history hole).
    const pending = (await ctx.get<TimelineEvent[]>(AGENT_KV.outbox)) ?? [];
    const existingRaw = await ctx.get<TimelineEvent[]>(AGENT_KV.context);
    const existing = existingRaw ?? [];
    const lastContextSeq = existing.length > 0 ? existing[existing.length - 1]!.seq : -1;
    const seen = new Set<number>();
    const unfolded = pending
      .filter((ev) => ev.seq > lastContextSeq && !seen.has(ev.seq) && (seen.add(ev.seq), true))
      .sort((a, b) => a.seq - b.seq);
    const foldedContext = selectContextEvents([...existing, ...unfolded], {
      ...(deps.contextOpaqueOrigins !== undefined && {
        includeOpaqueOrigins: deps.contextOpaqueOrigins,
      }),
    });

    // 3. The recovery snapshot: complete state as of its own seq (0001:A5),
    //    same bounded shape the archive writes (resurrection-compatible).
    //    Bounded (may throw → `failed`) BEFORE any destructive K/V write, so a
    //    failed recovery leaves the pending outbox intact for a later retry.
    const state: ArchiveSnapshotState = boundArchiveSnapshotState(
      {
        context: foldedContext,
        usage: (await ctx.get<RunUsage>(AGENT_KV.usage)) ?? ZERO_RUN_USAGE,
        workspaceRef: (await ctx.get<string>(AGENT_KV.workspaceRef)) ?? null,
        parentRef: (await ctx.get<string>(AGENT_KV.parentRef)) ?? null,
        subscribers: (await ctx.get<string[]>(AGENT_KV.subscribers)) ?? [],
        harness: (await ctx.get<JsonValue>(AGENT_KV.harness)) ?? null,
      },
      deps.archiveSnapshotMaxBytes,
    );
    // Journaled clock read BEFORE the destructive block: from here through the
    // epoch/offset writes there is no journal or transport boundary, so the
    // drop → stage → reset sequence commits atomically with the invocation —
    // no crash window can drop the stuck events without also staging the
    // historyHole snapshot that marks them (the reset property suite pins this).
    const now = await ctx.run("now-recovery", () => Date.now());
    ctx.set(AGENT_KV.context, foldedContext);
    ctx.set(AGENT_KV.outbox, []);
    let snapshot: TimelineEvent;
    try {
      const staged = await deps.outbox.stage(ctx, entityId, [
        {
          type: "state_snapshot",
          ts: isoTs(now),
          payload: {
            state: state as unknown as JsonValue,
            reason: "recovery",
            historyHole: true,
          },
        },
      ]);
      snapshot = staged[0]!;
    } catch (err) {
      // `stage` enforces the outbox's OWN budgets (`maxEventBytes` /
      // `maxPendingBytes`) — knobs independent of `archiveSnapshotMaxBytes`,
      // so a snapshot that passed the bound above can still be rejected here
      // (misconfigured limits). A throw at this point would otherwise COMMIT
      // the drop without the historyHole marker — an unmarked hole through a
      // non-crash path. Restore the pre-drop state (no journal boundary since
      // the drop, so this is atomic with it) and let the outer handler report
      // `failed` with the pending outbox intact for a later retry.
      if (existingRaw === null) ctx.clear(AGENT_KV.context);
      else ctx.set(AGENT_KV.context, existingRaw);
      ctx.set(AGENT_KV.outbox, pending);
      throw err;
    }
    const snapshotSeq = snapshot.seq;

    // 4. The reset (0001:A9). On a fence the server's epoch is authoritative —
    //    bump above whichever is higher.
    const storedEpoch = (await ctx.get<number>(OUTBOX_KV.producerEpoch)) ?? 0;
    const serverEpoch =
      drift.detail?.kind === "stale_epoch" ? (drift.detail.serverEpoch ?? storedEpoch) : storedEpoch;
    const epoch = Math.max(storedEpoch, serverEpoch) + 1;
    ctx.set(OUTBOX_KV.producerEpoch, epoch);
    ctx.set(OUTBOX_KV.producerSeqOffset, snapshotSeq);
    ctx.set(OUTBOX_KV.confirmedSeq, snapshotSeq - 1);
    ctx.clear(OUTBOX_KV.streamOffset);

    // 5. Append the snapshot at Producer-Seq 0 under the new epoch.
    let flushed = true;
    try {
      await deps.outbox.flush(ctx, entityId);
    } catch (err) {
      if (!(err instanceof OutboxDriftError)) throw err; // transient — Restate retries
      flushed = false; // e.g. closed stream — reset durable, snapshot pending, alert continues
    }
    return { performed: true, epoch, producerSeqOffset: snapshotSeq, snapshotSeq, flushed };
  } catch (err) {
    if (err instanceof restate.TerminalError) {
      // Never propagate a terminal failure to the reconciler tick (it would
      // kill the tick chain): report it; the alert already fired.
      return { performed: false, reason: "failed", message: err.message };
    }
    throw err;
  }
}
