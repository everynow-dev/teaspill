/**
 * Workspace stdout stream sink (0001:T4.1/0001:R4) — the seam through which the
 * executor host pushes exec output OUT-OF-BAND to the per-exec durable
 * stream (`/t/<tenant>/workspaces/<name>/exec/<execId>/stdout`,
 * https://teaspill.everynow.dev/reference/addressing). Bulk output NEVER rides the Restate journal
 * (0001:A4 §b); the journal carries `{ streamRef, tailBytes }` only.
 *
 * ## Invariants (mirror of 0001:T3.1's `emitDelta` fire-and-forget contract)
 *
 * - Appends are BEST-EFFORT TELEMETRY (0001:D1: streams are never read for
 *   control flow). A down streams server must never fail or slow an exec:
 *   implementations swallow errors; chunks may drop.
 * - Chunks are NOT idempotent-produced: an at-least-once host dispatch retry
 *   may duplicate chunks. Consumers treat this stream as lossy human-facing
 *   output; the authoritative record is the exec result (exitCode + tail) in
 *   the journal/timeline.
 * - C3 (durable-streams): a stream must be created before first append —
 *   hence `ensureStream` (idempotent re-PUT).
 *
 * ## Real implementation — deferred, version note
 *
 * The durable-streams JS client dep is chosen by 0001:T2.2 (must pin to the
 * protocol of server image `electricax/durable-streams-server-rust:0.1.4`,
 * per 0001:T1.1's worklog note). To avoid a version fork this package ships only
 * the seam + an in-memory implementation; platform wiring plugs the real
 * client once 0001:T2.2's pick lands. (Noted for main-session reconciliation.)
 */

import type { ExecOutputChunk } from "./adapter.js";

export interface WorkspaceStreamSink {
  /** Create the stream if absent (C3). Idempotent. Best-effort. */
  ensureStream(streamPath: string): Promise<void>;
  /** Append one output chunk. Best-effort — MUST NOT throw or block the exec. */
  append(streamPath: string, chunk: ExecOutputChunk): void;
}

/** No-op sink (deltas drop; execs unaffected) — the honest default until the real client is wired. */
export const noopStreamSink: WorkspaceStreamSink = {
  ensureStream: async () => undefined,
  append: () => undefined,
};

/** In-memory sink for tests and local dev inspection. */
export class InMemoryStreamSink implements WorkspaceStreamSink {
  readonly streams = new Map<string, ExecOutputChunk[]>();

  async ensureStream(streamPath: string): Promise<void> {
    if (!this.streams.has(streamPath)) this.streams.set(streamPath, []);
  }

  append(streamPath: string, chunk: ExecOutputChunk): void {
    // Mirrors C3: appends to a never-created stream are dropped (the real
    // server 404s; the sink swallows it — best-effort contract above).
    this.streams.get(streamPath)?.push(chunk);
  }

  text(streamPath: string, channel?: ExecOutputChunk["channel"]): string {
    return (this.streams.get(streamPath) ?? [])
      .filter((c) => channel === undefined || c.channel === channel)
      .map((c) => c.text)
      .join("");
  }
}
