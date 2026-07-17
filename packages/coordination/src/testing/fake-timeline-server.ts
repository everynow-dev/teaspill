/**
 * Faithful in-memory fake of the durable-streams server's idempotent
 * producer, at the `TimelineStreamTransport` seam (the transport speaks the
 * exact server verdict vocabulary, so the fake models the server, not the
 * HTTP encoding).
 *
 * `validate()` is a line-for-line port of `validate_producer`
 * (`../electric/packages/durable-streams-rust/src/handlers.rs` — the exact
 * source of image `electricax/durable-streams-server-rust:0.1.4`):
 *
 * - unknown producer: seq 0 → accept; else gap(expected 0)
 * - epoch < current → stale_epoch(current)
 * - epoch > current: seq 0 → accept (new epoch); else bad_epoch_start
 * - same epoch: seq <= last → duplicate(last); seq == last+1 → accept;
 *   else gap(expected last+1)
 *
 * plus the request-level rules around it: 404 before PUT-create (C3),
 * create is idempotent for an identical config and conflicts otherwise,
 * closed streams reject appends.
 *
 * Fault injection (`planFaults`) models the client-visible crash windows:
 * - `fail-before-apply` — the request never reached the server (connection
 *   refused / crash before send).
 * - `fail-after-apply`  — the server applied and acked but the ack was lost
 *   (crash between append and journal/trim). The next attempt of the same
 *   seq must come back `duplicate`.
 */

import type { TimelineEvent } from "@teaspill/schema";
import { parseTimelineEventJson } from "@teaspill/schema";
import type {
  ProducerAppendOutcome,
  ProducerRef,
  TimelineStreamTransport,
} from "../projection-outbox.js";

interface ProducerState {
  epoch: number;
  lastSeq: number;
}

interface FakeStream {
  contentType: string;
  /** One serialized record per accepted producer request (1 event : 1 seq). */
  records: string[];
  producers: Map<string, ProducerState>;
  closed: boolean;
}

export type PlannedFault = "ok" | "fail-before-apply" | "fail-after-apply";

export class SimulatedNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatedNetworkError";
  }
}

/** Port of handlers.rs `validate_producer` (see module header). */
export function validateProducer(
  state: ProducerState | undefined,
  p: { epoch: number; seq: number },
):
  | { kind: "accept" }
  | { kind: "duplicate"; lastSeq: number }
  | { kind: "stale_epoch"; currentEpoch: number }
  | { kind: "gap"; expectedSeq: number }
  | { kind: "bad_epoch_start" } {
  if (state === undefined) {
    return p.seq === 0 ? { kind: "accept" } : { kind: "gap", expectedSeq: 0 };
  }
  if (p.epoch < state.epoch) return { kind: "stale_epoch", currentEpoch: state.epoch };
  if (p.epoch > state.epoch) {
    return p.seq === 0 ? { kind: "accept" } : { kind: "bad_epoch_start" };
  }
  if (p.seq <= state.lastSeq) return { kind: "duplicate", lastSeq: state.lastSeq };
  if (p.seq === state.lastSeq + 1) return { kind: "accept" };
  return { kind: "gap", expectedSeq: state.lastSeq + 1 };
}

export class FakeTimelineServer implements TimelineStreamTransport {
  readonly streams = new Map<string, FakeStream>();
  /** Total append REQUESTS observed (including faulted/duplicate ones). */
  appendRequests = 0;
  createRequests = 0;
  #faultPlan: PlannedFault[] = [];

  /**
   * Queue per-append-request faults, consumed in order (missing entries are
   * "ok"). Applies to append requests only — create is left reliable so the
   * tests target the append protocol.
   */
  planFaults(plan: readonly PlannedFault[]): void {
    this.#faultPlan.push(...plan);
  }

  /** Drop any un-consumed planned faults (between simulated attempts). */
  clearFaults(): void {
    this.#faultPlan = [];
  }

  async createStream(path: string): Promise<"created" | "exists"> {
    this.createRequests += 1;
    const existing = this.streams.get(path);
    if (existing) {
      if (existing.contentType !== "application/json") {
        throw new Error(`409 stream exists with different configuration`);
      }
      return "exists";
    }
    this.streams.set(path, {
      contentType: "application/json",
      records: [],
      producers: new Map(),
      closed: false,
    });
    return "created";
  }

  async appendEvent(
    path: string,
    eventJson: string,
    producer: ProducerRef,
  ): Promise<ProducerAppendOutcome> {
    this.appendRequests += 1;
    const fault = this.#faultPlan.shift() ?? "ok";
    if (fault === "fail-before-apply") {
      throw new SimulatedNetworkError(
        `append ${path} seq ${producer.seq}: connection lost before send`,
      );
    }

    const outcome = this.#apply(path, eventJson, producer);

    if (fault === "fail-after-apply") {
      throw new SimulatedNetworkError(`append ${path} seq ${producer.seq}: ack lost after apply`);
    }
    return outcome;
  }

  #apply(path: string, eventJson: string, producer: ProducerRef): ProducerAppendOutcome {
    const stream = this.streams.get(path);
    if (!stream) return { kind: "stream_not_found" };
    if (stream.closed) return { kind: "closed" };
    const verdict = validateProducer(stream.producers.get(producer.id), producer);
    switch (verdict.kind) {
      case "accept":
        stream.records.push(eventJson);
        stream.producers.set(producer.id, { epoch: producer.epoch, lastSeq: producer.seq });
        return { kind: "accepted" };
      case "duplicate":
        return { kind: "duplicate", lastSeq: verdict.lastSeq };
      case "gap":
        return { kind: "gap", expectedSeq: verdict.expectedSeq, receivedSeq: producer.seq };
      case "stale_epoch":
        return { kind: "stale_epoch", currentEpoch: verdict.currentEpoch };
      case "bad_epoch_start":
        return { kind: "bad_epoch_start" };
      default: {
        const exhaustive: never = verdict;
        throw new Error(`unreachable ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Parsed timeline for a stream path (empty when the stream doesn't exist). */
  timeline(path: string): TimelineEvent[] {
    return (this.streams.get(path)?.records ?? []).map(parseTimelineEventJson);
  }

  /** Close a stream (models the T8.1 terminal close; appends then reject). */
  closeStream(path: string): void {
    const stream = this.streams.get(path);
    if (stream) stream.closed = true;
  }

  /**
   * Model the server-side catastrophic cases the reconciler owns (D3):
   * delete the stream entirely, or roll producer state back while keeping
   * records (the documented debounced-producer-meta crash window).
   */
  deleteStream(path: string): void {
    this.streams.delete(path);
  }
  rollbackProducerState(path: string, producerId: string, lastSeq: number): void {
    const stream = this.streams.get(path);
    if (!stream) return;
    const state = stream.producers.get(producerId);
    if (state) stream.producers.set(producerId, { ...state, lastSeq });
  }
}
