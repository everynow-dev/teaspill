/**
 * Best-effort per-entity token-delta emitter (0002:T4.2) — the concrete
 * consumer of coordination's additive `emitDeltaFactory` seam, closing the
 * 0002:T4.1 flag ("`DeltaInit` carries no entityId, config-level emitter
 * can't stamp it → deltas left no-op").
 *
 * Deltas are LOSSY live telemetry (schema deltas.ts, 0001:A7): they ride the
 * sibling `/deltas` stream as PLAIN appends (no producer protocol, no seq)
 * with a sliding `Stream-TTL` (0001:A7's proposed 6h default), and the
 * emitter must NEVER throw or block a run — same invariants as harness-native's
 * `createSafeDeltaEmitter`, which this factory wraps.
 */

import { createSafeDeltaEmitter, type EmitDelta } from "@teaspill/harness-native";
import { deltasStreamPath, type DeltaInit, type DeltaRecord } from "@teaspill/schema";

export interface DeltaEmitterFactoryOptions {
  /** durable-streams base url as seen from THIS process (e.g. `http://durable-streams:4437`). */
  streamsUrl: string;
  /** Sliding TTL for `/deltas` streams, seconds. Default 6h (0001:A7). */
  ttlSeconds?: number;
  fetch?: typeof fetch;
  /** Observe dropped deltas (metrics/logs). Default: silent. */
  onDrop?: (err: unknown) => void;
}

const DEFAULT_DELTAS_TTL_SECONDS = 6 * 60 * 60;

/**
 * Build coordination's `emitDeltaFactory`: per entity, lazily PUT-create the
 * `/deltas` stream (with `Stream-TTL`) once, then fire-and-forget plain
 * appends of the full `DeltaRecord` (v1 + entityId stamped here — the one
 * piece of context the config-level `emitDelta` seam could not supply).
 */
export function createDeltaEmitterFactory(
  opts: DeltaEmitterFactoryOptions,
): (bind: { entityId: string }) => EmitDelta {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = opts.streamsUrl.replace(/\/$/, "");
  const ttl = opts.ttlSeconds ?? DEFAULT_DELTAS_TTL_SECONDS;
  // Ensure memo per stream path — process-wide is fine (idempotent PUT).
  const ensured = new Map<string, Promise<void>>();

  const ensureOnce = (path: string): Promise<void> => {
    let pending = ensured.get(path);
    if (!pending) {
      pending = doFetch(`${base}${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "stream-ttl": String(ttl) },
      }).then(
        (res) => {
          // A non-2xx create must not memoize as ensured (fetch resolves on
          // any HTTP status) — forget it so a later delta retries.
          if (!res.ok) ensured.delete(path);
        },
        () => {
          ensured.delete(path);
        },
      );
      ensured.set(path, pending);
    }
    return pending;
  };

  return ({ entityId }) => {
    const path = deltasStreamPath(entityId);
    return createSafeDeltaEmitter(
      (delta: DeltaInit) => {
        const record: DeltaRecord = { ...delta, v: 1, entityId } as DeltaRecord;
        return ensureOnce(path).then(() =>
          doFetch(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify([record]),
          }).then((res) => {
            if (!res.ok) throw new Error(`deltas append ${path}: HTTP ${res.status}`);
          }),
        );
      },
      { ...(opts.onDrop !== undefined && { onDrop: opts.onDrop }) },
    );
  };
}
