/**
 * `createAgentTimeline` (0001:T5.2): framework-agnostic store that reads an
 * entity's timeline stream (+ optionally the sibling `/deltas` stream)
 * through the gateway with `@durable-streams/client`, folds every record
 * through the pure reducer (reducer.ts), and exposes a subscribable
 * snapshot for UIs. React bindings live in react.ts; the core has no
 * framework dependency.
 *
 * Read path (0001:D1/0001:A7): the timeline is resumable and HTTP-cacheable; a full
 * history read starts at offset "-1", a fast-join starts at the catalog's
 * snapshot offset and the reducer verifies snapshot(seq=N) → N+1, N+2…
 * (`fromSnapshot`). Ordering/dedup/drift rules are entirely the reducer's —
 * see its header for the 0001:A6 idempotency and finalized-wins contracts.
 */

import {
  stream,
  type BackoffOptions,
  type LiveMode,
  type StreamResponse,
} from "@durable-streams/client";
import {
  safeParseDeltaRecord,
  safeParseTimelineEvent,
  type DeltaRecord,
  type TimelineEvent,
} from "@teaspill/schema";
import { authHeaders, type TeaspillAuth } from "./auth.js";
import {
  applyDeltaRecords,
  applyTimelineEvents,
  initialTimelineState,
  type DriftInfo,
  type TimelineState,
} from "./reducer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Store snapshot: the reducer's state plus transport-level status. */
export interface AgentTimelineState {
  timeline: TimelineState;
  /** True once the timeline read caught up with the stream head. */
  upToDate: boolean;
  /** Resumption offset of the timeline read (persist to resume cheaply). */
  streamOffset: string | null;
  /** True when the server closed the timeline stream (EOF). */
  streamClosed: boolean;
  /** Records that failed schema validation (skipped, surfaced, never fatal). */
  parseErrors: number;
  /** Last transport/parse error observed (informational; retries continue). */
  lastError: unknown;
}

export interface AgentTimelineOptions {
  /**
   * Fast-join point (0001:A7): `seq` is the `state_snapshot`'s canonical seq (the
   * catalog's `snapshot_offset`); `offset`, when known, is the stream read
   * offset to start from (otherwise the read starts at the beginning and the
   * reducer skips records below the join seq).
   */
  fromSnapshot?: { seq: number; offset?: string };
  /** API key or read token (0001:T1.4). See auth.ts. */
  auth?: TeaspillAuth;
  /**
   * Subscribe to the sibling `/deltas` stream for live token streaming.
   * `true` derives the sibling URL from a `…/timeline` URL; pass an explicit
   * URL otherwise. Deltas are best-effort (droppable) — see deltas.ts.
   */
  deltas?: boolean | { url: string | URL };
  /** Live mode for the timeline read (default `true`: catch up, then follow). */
  live?: LiveMode;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  backoffOptions?: BackoffOptions;
  /** Called whenever the reducer records new drift (0001:D3 seq-gap detector). */
  onDrift?: (drift: DriftInfo, state: AgentTimelineState) => void;
  /** Called for records that fail schema validation (they are skipped). */
  onRecordError?: (error: unknown, raw: unknown) => void;
}

export interface AgentTimeline {
  getState(): AgentTimelineState;
  /** Subscribe to state changes (one notification per applied batch). */
  subscribe(listener: (state: AgentTimelineState) => void): () => void;
  /** Resolves when the timeline read first reports up-to-date. */
  untilUpToDate(): Promise<AgentTimelineState>;
  /** Abort all reads. Idempotent. */
  close(): void;
  /** Settles when every underlying session has fully closed. */
  readonly closed: Promise<void>;
}

/** Derive the sibling `/deltas` stream URL from a `…/timeline` URL. */
export function deltasUrlFor(timelineUrl: string | URL): string {
  const url = String(timelineUrl);
  const [path, query] = splitQuery(url);
  if (!path.endsWith("/timeline")) {
    throw new Error(
      `cannot derive the deltas stream from ${JSON.stringify(url)} — expected a path ending in "/timeline" (docs/addressing.md §4.2); pass deltas: { url } explicitly`,
    );
  }
  return path.slice(0, -"/timeline".length) + "/deltas" + query;
}

function splitQuery(url: string): [string, string] {
  const i = url.indexOf("?");
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createAgentTimeline(
  streamUrl: string | URL,
  opts: AgentTimelineOptions = {},
): AgentTimeline {
  const listeners = new Set<(s: AgentTimelineState) => void>();
  const controller = new AbortController();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason as Error | undefined);
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let state: AgentTimelineState = {
    timeline: initialTimelineState(
      opts.fromSnapshot !== undefined ? { fromSnapshot: { seq: opts.fromSnapshot.seq } } : {},
    ),
    upToDate: false,
    streamOffset: null,
    streamClosed: false,
    parseErrors: 0,
    lastError: null,
  };

  const notify = (): void => {
    for (const l of listeners) l(state);
  };

  let resolveUpToDate: ((s: AgentTimelineState) => void) | null = null;
  let rejectUpToDate: ((e: unknown) => void) | null = null;
  const upToDatePromise = new Promise<AgentTimelineState>((resolve, reject) => {
    resolveUpToDate = resolve;
    rejectUpToDate = reject;
  });
  // Avoid unhandled-rejection noise when the caller never awaits it.
  upToDatePromise.catch(() => {});

  const headers = authHeaders(opts.auth);
  const sessions: Promise<void>[] = [];

  const applyBatch = (
    items: readonly unknown[],
    meta: { offset: string; upToDate: boolean; streamClosed: boolean },
  ): void => {
    const events: TimelineEvent[] = [];
    let parseErrors = state.parseErrors;
    for (const raw of items) {
      const parsed = safeParseTimelineEvent(raw);
      if (parsed.success) events.push(parsed.data);
      else {
        parseErrors += 1;
        opts.onRecordError?.(parsed.error, raw);
      }
    }
    const prevDriftCount = state.timeline.driftCount;
    const timeline =
      events.length > 0 ? applyTimelineEvents(state.timeline, events) : state.timeline;
    state = {
      ...state,
      timeline,
      parseErrors,
      upToDate: state.upToDate || meta.upToDate,
      streamOffset: meta.offset,
      streamClosed: meta.streamClosed,
    };
    if (timeline.driftCount > prevDriftCount && timeline.drift !== null) {
      opts.onDrift?.(timeline.drift, state);
    }
    notify();
    if (meta.upToDate && resolveUpToDate !== null) {
      resolveUpToDate(state);
      resolveUpToDate = null;
      rejectUpToDate = null;
    }
  };

  const applyDeltaBatch = (items: readonly unknown[]): void => {
    const deltas: DeltaRecord[] = [];
    let parseErrors = state.parseErrors;
    for (const raw of items) {
      const parsed = safeParseDeltaRecord(raw);
      if (parsed.success) deltas.push(parsed.data);
      else {
        parseErrors += 1;
        opts.onRecordError?.(parsed.error, raw);
      }
    }
    if (deltas.length === 0 && parseErrors === state.parseErrors) return;
    state = {
      ...state,
      timeline: deltas.length > 0 ? applyDeltaRecords(state.timeline, deltas) : state.timeline,
      parseErrors,
    };
    notify();
  };

  const fail = (error: unknown): void => {
    state = { ...state, lastError: error };
    notify();
    if (rejectUpToDate !== null) {
      rejectUpToDate(error);
      rejectUpToDate = null;
      resolveUpToDate = null;
    }
  };

  // -- timeline session -----------------------------------------------------
  sessions.push(
    (async () => {
      let res: StreamResponse<unknown>;
      try {
        res = await stream({
          url: streamUrl,
          headers,
          offset: opts.fromSnapshot?.offset ?? "-1",
          live: opts.live ?? true,
          json: true,
          signal: controller.signal,
          ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
          ...(opts.backoffOptions !== undefined ? { backoffOptions: opts.backoffOptions } : {}),
        });
      } catch (error) {
        if (!controller.signal.aborted) fail(error);
        return;
      }
      res.subscribeJson((batch) => {
        applyBatch(batch.items, {
          offset: batch.offset,
          upToDate: batch.upToDate,
          streamClosed: batch.streamClosed,
        });
      });
      await res.closed.catch((error: unknown) => {
        if (!controller.signal.aborted) fail(error);
      });
    })(),
  );

  // -- deltas session (optional, best-effort) -------------------------------
  if (opts.deltas !== undefined && opts.deltas !== false) {
    const deltasUrl = opts.deltas === true ? deltasUrlFor(streamUrl) : String(opts.deltas.url);
    sessions.push(
      (async () => {
        let res: StreamResponse<unknown>;
        try {
          res = await stream({
            url: deltasUrl,
            headers,
            // Deltas are worthless history (deltas.ts): a UI only wants the
            // live tail, and the reducer drops anything already finalized.
            offset: "-1",
            live: opts.live ?? true,
            json: true,
            signal: controller.signal,
            ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
            ...(opts.backoffOptions !== undefined ? { backoffOptions: opts.backoffOptions } : {}),
          });
        } catch (error) {
          // A missing deltas stream is normal for an idle entity (0001:T5.1 TTL);
          // it must never break the timeline read.
          if (!controller.signal.aborted) {
            state = { ...state, lastError: error };
            notify();
          }
          return;
        }
        res.subscribeJson((batch) => {
          applyDeltaBatch(batch.items);
        });
        await res.closed.catch(() => {});
      })(),
    );
  }

  const closed = Promise.allSettled(sessions).then(() => {});

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    untilUpToDate: () => upToDatePromise,
    close: () => controller.abort(),
    closed,
  };
}
