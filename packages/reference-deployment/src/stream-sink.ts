/**
 * Best-effort durable-streams `WorkspaceStreamSink` (0002:T4.1) — the real
 * out-of-band exec-output sink the executor package deliberately left as a
 * seam (`packages/executor/src/stream-sink.ts` version note).
 *
 * Speaks the same 0.1.4 wire shape as coordination's
 * `HttpTimelineStreamTransport`: `PUT <path>` creates the stream (idempotent),
 * `POST <path>` with a JSON ARRAY body appends records — but as a PLAIN
 * (non-producer) append: exec output chunks are lossy human-facing telemetry
 * (0001:R4 — the authoritative record is `{ exitCode, tail }` in the
 * journal), so no producer headers, no seq, no dedup.
 *
 * Honors the sink invariants: NEVER throws, NEVER blocks the exec, drops
 * chunks when the server is down.
 */

import type { ExecOutputChunk, WorkspaceStreamSink } from "@teaspill/executor";

export interface DurableStreamsSinkOptions {
  /** durable-streams server base url as seen from the executor host (e.g. `http://durable-streams:4437`). */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Observe dropped appends (metrics/logs). Default: silent. */
  onDrop?: (err: unknown) => void;
}

export function createDurableStreamsSink(opts: DurableStreamsSinkOptions): WorkspaceStreamSink {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = opts.baseUrl.replace(/\/$/, "");
  const drop = (err: unknown): void => {
    try {
      opts.onDrop?.(err);
    } catch {
      // onDrop must not break the invariant either.
    }
  };

  return {
    async ensureStream(streamPath: string): Promise<void> {
      try {
        await doFetch(`${base}${streamPath}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        drop(err); // best-effort: a down server must not fail the exec
      }
    },
    append(streamPath: string, chunk: ExecOutputChunk): void {
      try {
        void doFetch(`${base}${streamPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([chunk]),
        }).then(
          (res) => {
            if (!res.ok) drop(new Error(`append ${streamPath}: HTTP ${res.status}`));
          },
          (err: unknown) => drop(err),
        );
      } catch (err) {
        drop(err);
      }
    },
  };
}
