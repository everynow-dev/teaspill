/**
 * T2.2 — Projection outbox + idempotent append (D3, exactly).
 *
 * `DurableStreamsProjectionOutbox` is the REAL implementation of the
 * `ProjectionOutbox` seam T2.1 defined in ./agent-seams.ts (the stub
 * `InMemoryProjectionOutbox` stays there for the T2.1 tests). It is the ONLY
 * seq allocator in the system (A1) and the only writer of the timeline
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
 *   `Producer-Seq == canonical seq` holds exactly (D3's `(entityId, seq)`
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
 *   deterministically (T5.2 reducer rule: same seq ⇒ same event) and the
 *   T5.3 reconciler can detect/verify. No client-side action can close this;
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
 * `(entityId, canonicalSeq)` dedup D3 requires across process restarts and
 * Restate retries. The low-level `DurableStream.append` in 0.2.6 declares
 * producer fields on `AppendOptions` but never sends them (dead options).
 * So this module performs the producer append itself (one small POST per
 * event with explicit headers — the thin mapping PLAN T2.2 anticipated),
 * importing the pinned client's header constants to stay anchored to the
 * protocol lib; readers (T5.2, integration tests) use the client fully.
 *
 * ## Flush protocol (D3: confirm-then-trim, in-order replay)
 *
 * 1. Read the pending outbox + `outboxConfirmedSeq` from K/V. Empty → done.
 * 2. Pre-validate: pending is seq-contiguous ascending (a hole here is
 *    internal corruption → `OutboxDriftError` BEFORE any I/O).
 * 3. ONE `ctx.run` step appends every pending event IN ORDER from the first
 *    unconfirmed: accepted and duplicate outcomes both mean "on the stream";
 *    404 → PUT-create (C3) then retry the append once; gap / stale-epoch /
 *    closed → `OutboxDriftError` (drift is the T5.3 reconciler's job — the
 *    outbox never papers over it). The closure honors `ctx.runAbortSignal`
 *    (A4 zombie discipline). A transient failure mid-loop throws out of the
 *    `ctx.run`; the retried attempt re-runs the loop from pending[0] and the
 *    already-appended prefix dedups as duplicates — this is exactly the
 *    "replay IN ORDER from the first unconfirmed" C4 requirement, and it is
 *    why the pending array is never partially trimmed.
 * 4. Only after the append step commits: trim the outbox to `[]` and set
 *    `outboxConfirmedSeq` (the cheap last-confirmed tracker T5.3 reads via
 *    the catalog).
 * 5. Upsert catalog `head_seq` + `status` in a second `ctx.run` (D1: catalog
 *    written only via ctx.run). `head_seq` in the catalog is the last
 *    CONFIRMED seq — updated at trim time, per PLAN T5.3's anticipate.
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
 *   monotonic via GREATEST in the writer); the reconciler (T5.3) treats
 *   catalog `head_seq` as a floor, not an exact match.
 *
 * ## Epoch (v1 stance)
 *
 * `Producer-Epoch` is read from K/V `outboxProducerEpoch` (absent ⇒ 0) and
 * is CONSTANT in normal operation (addressing.md §7). Bumping it is reserved
 * for the deliberate post-catastrophic-stream-loss reset (D3 / T5.3): that
 * path must append a `state_snapshot`, bump the epoch, and restart
 * `Producer-Seq` at 0 — which breaks the `Producer-Seq == seq` identity and
 * therefore also requires storing a producer-seq offset. v1 does not
 * implement the reset; `OutboxDriftError` surfaces the conditions that
 * require it.
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
import type { TimelineEvent, TimelineEventInit } from "@teaspill/schema";
import { checkSeqContiguity, finalizeEvent } from "@teaspill/schema";
import type { AgentRuntimeCtx, EntityStatus } from "./agent-runtime.js";
import { AGENT_KV } from "./agent-runtime.js";
import type { OutboxFlushResult, ProjectionOutbox } from "./agent-seams.js";
import { parseEntityUrlLite } from "./agent-seams.js";

// ---------------------------------------------------------------------------
// K/V keys owned by this module (additive to AGENT_KV; same object namespace)
// ---------------------------------------------------------------------------

export const OUTBOX_KV = {
  /**
   * `number` — seq of the last event CONFIRMED onto the timeline stream
   * (trimmed from the outbox). Absent ⇒ nothing ever confirmed (or K/V was
   * cleared by archive, T8.1 — flush recovers it from append outcomes).
   * This is the cheap "last-confirmed-seq tracked at trim time" the T5.3
   * drift reconciler compares against the catalog/stream (PLAN T5.3).
   */
  confirmedSeq: "outboxConfirmedSeq",
  /**
   * `number` — durable-streams `Producer-Epoch` (absent ⇒ 0). Constant in
   * normal operation; bump reserved for the T5.3 catastrophic-reset path
   * (see module header).
   */
  producerEpoch: "outboxProducerEpoch",
  /**
   * `string` — the last-known durable-streams `Stream-Next-Offset` (opaque
   * read offset marking the current stream END). Updated at flush time from
   * the final accepted append's returned offset (T8.1 byte-offset capture).
   * Used to compute the read offset at which a `state_snapshot` record
   * BEGINS (= the stream end just before that record is appended) so T5.2 can
   * seek to the snapshot without scanning from 0. Absent ⇒ unknown (fresh
   * stream / never captured); the snapshot-offset capture is best-effort and
   * simply skips when the begin-offset is unknown (see flush). NOT read for
   * control flow — a pure seek hint.
   */
  streamOffset: "outboxStreamOffset",
} as const;

// ---------------------------------------------------------------------------
// Addressing (docs/addressing.md §4.1/§7) — local until they land in schema
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
// Catalog seam (D1: catalog written only from inside handlers via ctx.run)
// ---------------------------------------------------------------------------

export interface OutboxCatalogUpsert {
  entityId: string;
  /** Last CONFIRMED seq (trim-time value — the T5.3 comparison anchor). */
  headSeq: number;
  status: EntityStatus;
}

export interface OutboxCatalogSnapshotUpsert {
  entityId: string;
  /** Canonical seq of the `state_snapshot` event (catalog `snapshot_offset`; A7). */
  snapshotSeq: number;
  /**
   * Opaque durable-streams read offset at which that snapshot record BEGINS
   * (catalog `snapshot_stream_offset`; T8.1 / T5.2 fast-join seek hint), when
   * the outbox could determine it. Omitted when unknown.
   */
  snapshotStreamOffset?: string;
}

/** Implemented for real over Drizzle in ./projection-catalog.ts. */
export interface OutboxCatalog {
  upsertHead(upsert: OutboxCatalogUpsert): Promise<void>;
  /**
   * Record the latest `state_snapshot`'s seq + (when known) its stream begin
   * offset (T8.1). Monotonic (GREATEST on seq) in the real writer. Optional so
   * pre-T8.1 catalog writers / test fakes need not implement it — the outbox
   * only calls it when a flush actually appended a `state_snapshot`.
   */
  upsertSnapshot?(upsert: OutboxCatalogSnapshotUpsert): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Projection drift: the stream's producer state and the entity's K/V
 * disagree in a way in-order replay cannot fix (seq gap below the first
 * unconfirmed event, fenced epoch, closed stream). Terminal so Restate does
 * NOT hot-loop the wake; the outbox stays intact (K/V commits are
 * unaffected), every later flush re-surfaces the error, and repair belongs
 * to the T5.3 reconciler (D3 catastrophic path: state_snapshot + epoch bump
 * + producer-seq restart).
 */
export class OutboxDriftError extends restate.TerminalError {
  constructor(message: string) {
    super(message, { errorCode: 409 });
    this.name = "OutboxDriftError";
  }
}

/** A single event (or the pending outbox value) exceeds the journal budget (A4/R4). */
export class OutboxBudgetError extends restate.TerminalError {
  constructor(message: string) {
    super(message, { errorCode: 413 });
    this.name = "OutboxBudgetError";
  }
}

// ---------------------------------------------------------------------------
// The real ProjectionOutbox (T2.2)
// ---------------------------------------------------------------------------

/** ~1 MiB — the A4 journal-entry design budget (SPIKE §b). */
export const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

export interface DurableStreamsOutboxOptions {
  transport: TimelineStreamTransport;
  /** Optional catalog writer; omit in tests / when the catalog is wired elsewhere. */
  catalog?: OutboxCatalog;
  /** Per-event serialized-size ceiling (A4 ~1 MiB journal budget). */
  maxEventBytes?: number;
  /** Serialized pending-outbox K/V value ceiling (same budget; callers chunk, R4). */
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
   * THE seq allocator (A1): 0-based gapless from the K/V `seq` counter,
   * atomic with the invocation under single-writer (D3). Pure K/V — no I/O,
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
            `(A4 journal budget). Event payloads must be summaries/refs — bulk goes to streams (D1/R4).`,
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
          `would exceed the ${this.#maxPendingBytes}B K/V budget (A4). ` +
          `Interleave stage/flush in bounded chunks (commitEventsChunked, R4).`,
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
      );
    }
    if (confirmedSeq !== null && first.seq !== confirmedSeq + 1) {
      throw new OutboxDriftError(
        `pending outbox for ${entityId} starts at seq ${first.seq} but last confirmed is ${confirmedSeq} ` +
          `(expected ${confirmedSeq + 1}).`,
      );
    }

    const epoch = (await ctx.get<number>(OUTBOX_KV.producerEpoch)) ?? 0;
    const priorStreamOffset = await ctx.get<string>(OUTBOX_KV.streamOffset);
    const path = timelineStreamPath(entityId);
    const producerId = timelineProducerId(entityId);
    const signal = ctx.runAbortSignal;
    const transport = this.#transport;

    // ONE journaled step for the whole (bounded, ≤ chunk-size) batch. The
    // closure is at-least-once (SPIKE §e-2): every re-execution replays the
    // SAME events in the SAME order from pending[0], and the idempotent
    // producer turns the already-appended prefix into duplicate no-ops. The
    // RESULT (append count + captured snapshot offsets + end offset) is
    // journaled once and never re-executed (SPIKE §e-1), so the offset capture
    // is replay-stable.
    const flushOutcome = await ctx.run("outbox-flush", async () => {
      let newlyAppended = 0;
      let createdOnDemand = false;
      // T8.1 byte-offset capture: track the stream's current END offset. A
      // `state_snapshot` record BEGINS at the end offset that stood just
      // before its own append, which is exactly the offset a reader seeks to
      // so the snapshot is the first record it sees. `running` advances only
      // on a confirmed (accepted) append's `Stream-Next-Offset`; on a
      // duplicate we leave it unchanged (it may lag the true end — which only
      // ever makes a captured begin-offset EARLIER, never later, so a reader
      // over-reads a few records at worst; the reducer's fast-join seq floor
      // (A6 #5) discards them). `null` ⇒ unknown ⇒ that snapshot's offset is
      // simply not captured (the catalog column stays null; T5.2 falls back to
      // a seq-only fast-join).
      let running: string | null = priorStreamOffset;
      const snapshotOffsets: { seq: number; offset: string }[] = [];
      for (const ev of pending) {
        signal.throwIfAborted();
        const offsetBefore = running;
        const eventJson = JSON.stringify(ev);
        const producer: ProducerRef = { id: producerId, epoch, seq: ev.seq };
        let outcome = await transport.appendEvent(path, eventJson, producer, { signal });
        if (outcome.kind === "stream_not_found" && !createdOnDemand) {
          // C3: PUT-create before first append (idempotent; also covers a
          // replayed first flush racing its own earlier create).
          await transport.createStream(path, { signal });
          createdOnDemand = true;
          outcome = await transport.appendEvent(path, eventJson, producer, { signal });
        }
        if (ev.type === "state_snapshot" && offsetBefore !== null) {
          snapshotOffsets.push({ seq: ev.seq, offset: offsetBefore });
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
            throw new OutboxDriftError(
              `producer seq gap for ${entityId}: server expects ${outcome.expectedSeq}, ` +
                `outbox replayed ${outcome.receivedSeq}. The stream tail is behind the trimmed ` +
                `outbox (stream loss / producer-state rollback) — reconciler repair required (D3/T5.3).`,
            );
          case "stale_epoch":
            throw new OutboxDriftError(
              `producer epoch ${epoch} for ${entityId} is fenced (server epoch ${outcome.currentEpoch}). ` +
                `Only the T5.3 reset path bumps epochs — investigate before writing.`,
            );
          case "bad_epoch_start":
            throw new OutboxDriftError(
              `producer epoch ${epoch} for ${entityId} is new to the server but the outbox starts at ` +
                `seq ${ev.seq} (must be 0). Epoch resets must restart Producer-Seq at 0 (addressing §7).`,
            );
          case "closed":
            throw new OutboxDriftError(
              `timeline stream for ${entityId} is closed — no further appends are possible.`,
            );
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
      return { newlyAppended, snapshotOffsets, endOffset: running };
    });
    const appended = flushOutcome.newlyAppended;

    // Confirm-then-trim (D3): every pending event is now on the stream (the
    // append step above either confirmed all of them or threw).
    const headSeq = pending[pending.length - 1]!.seq;
    ctx.set(AGENT_KV.outbox, []);
    ctx.set(OUTBOX_KV.confirmedSeq, headSeq);
    // Persist the last-known stream end offset for the next flush's capture
    // (only when known — never overwrite a good value with null).
    if (flushOutcome.endOffset !== null) {
      ctx.set(OUTBOX_KV.streamOffset, flushOutcome.endOffset);
    }

    // Catalog head_seq/status upsert alongside (D1: via ctx.run). Runs after
    // trim; a crash in between leaves catalog head_seq lagging (a floor —
    // documented in the crash matrix; T5.3 compares accordingly).
    if (this.#catalog) {
      const catalog = this.#catalog;
      const status = (await ctx.get<EntityStatus>(AGENT_KV.status)) ?? "active";
      await ctx.run("outbox-catalog", () => catalog.upsertHead({ entityId, headSeq, status }));
      // Latest snapshot's seq (+ begin offset when captured) — T8.1/T5.2
      // fast-join hint. Only when this flush appended a `state_snapshot`.
      if (catalog.upsertSnapshot && flushOutcome.snapshotOffsets.length > 0) {
        const latest = flushOutcome.snapshotOffsets[flushOutcome.snapshotOffsets.length - 1]!;
        const upsertSnapshot = catalog.upsertSnapshot.bind(catalog);
        await ctx.run("outbox-catalog-snapshot", () =>
          upsertSnapshot({
            entityId,
            snapshotSeq: latest.seq,
            snapshotStreamOffset: latest.offset,
          }),
        );
      }
    }

    return { appended, headSeq };
  }
}
