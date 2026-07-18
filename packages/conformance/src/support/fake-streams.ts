/**
 * A faithful in-memory durable-streams server at the `TimelineStreamTransport`
 * seam (coordination/projection-outbox), for the offline crash-resume and
 * projection-continuity scenarios. `validateProducer` is the same line-for-line
 * port of the pinned server's `validate_producer` (handlers.rs, image
 * `electricax/durable-streams-server-rust:0.1.4`) that coordination's own
 * property-test fake uses — reproduced here so the conformance kit is
 * self-contained (coordination does not export its test fake).
 *
 * Beyond the protocol it models the two fault windows the scenarios need:
 *   - `planFaults([...])` — per-append-request transport faults:
 *       `fail-before-apply` (request never reached the server) and
 *       `fail-after-apply` (server applied+acked but the ack was lost).
 *   - `restart({ rollbackProducersTo })` — a streams-server restart: WAL-fsynced
 *       RECORDS survive, but the DEBOUNCED producer-dedup state can roll back to
 *       an earlier checkpoint (0001:A6 #2). A subsequent re-append of an already-acked
 *       seq is then re-admitted as a DUPLICATE RECORD — which readers must dedup
 *       by embedded canonical seq.
 */

import { parseTimelineEventJson, type TimelineEvent } from "@teaspill/schema";
import type {
  ProducerAppendOutcome,
  ProducerRef,
  TimelineStreamTransport,
} from "@teaspill/coordination";

interface ProducerState {
  epoch: number;
  lastSeq: number;
}

interface FakeStream {
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

/** Port of handlers.rs `validate_producer`. */
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

export class FakeStreamsServer implements TimelineStreamTransport {
  readonly #streams = new Map<string, FakeStream>();
  #faultPlan: PlannedFault[] = [];
  appendRequests = 0;

  planFaults(plan: readonly PlannedFault[]): void {
    this.#faultPlan.push(...plan);
  }
  clearFaults(): void {
    this.#faultPlan = [];
  }

  createStream(path: string): Promise<"created" | "exists"> {
    const existing = this.#streams.get(path);
    if (existing) return Promise.resolve("exists");
    this.#streams.set(path, { records: [], producers: new Map(), closed: false });
    return Promise.resolve("created");
  }

  async appendEvent(
    path: string,
    eventJson: string,
    producer: ProducerRef,
  ): Promise<ProducerAppendOutcome> {
    this.appendRequests += 1;
    const fault = this.#faultPlan.shift() ?? "ok";
    if (fault === "fail-before-apply") {
      throw new SimulatedNetworkError(`append ${path} seq ${producer.seq}: lost before send`);
    }
    const outcome = this.#apply(path, eventJson, producer);
    if (fault === "fail-after-apply") {
      throw new SimulatedNetworkError(`append ${path} seq ${producer.seq}: ack lost after apply`);
    }
    return outcome;
  }

  #apply(path: string, eventJson: string, producer: ProducerRef): ProducerAppendOutcome {
    const stream = this.#streams.get(path);
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
    }
  }

  /**
   * Model a streams-server restart. Records are WAL-durable (kept); the
   * debounced producer-dedup state may roll back to an earlier checkpoint.
   * `rollbackProducersTo` sets every producer's recovered `lastSeq` to the
   * given value (0001:A6 #2) — a later re-append of a seq > that value re-admits a
   * duplicate RECORD, which the reader must dedup by embedded canonical seq.
   */
  restart(opts: { rollbackProducersTo?: number } = {}): void {
    this.clearFaults();
    if (opts.rollbackProducersTo === undefined) return;
    for (const stream of this.#streams.values()) {
      for (const [id, state] of stream.producers) {
        stream.producers.set(id, {
          epoch: state.epoch,
          lastSeq: Math.min(state.lastSeq, opts.rollbackProducersTo),
        });
      }
    }
  }

  /** Raw serialized records on a stream (may contain 0001:A6 duplicate readmissions). */
  rawRecords(path: string): string[] {
    return [...(this.#streams.get(path)?.records ?? [])];
  }

  /** Parsed timeline records for a stream path (in append order). */
  timeline(path: string): TimelineEvent[] {
    return this.rawRecords(path).map(parseTimelineEventJson);
  }

  /** Reader dedup by canonical seq (finalized-event-wins, first occurrence kept). */
  dedupBySeq(path: string): TimelineEvent[] {
    const seen = new Set<number>();
    const out: TimelineEvent[] = [];
    for (const ev of this.timeline(path)) {
      if (seen.has(ev.seq)) continue;
      seen.add(ev.seq);
      out.push(ev);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }
}
