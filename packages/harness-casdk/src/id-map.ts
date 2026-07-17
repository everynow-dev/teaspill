/**
 * Bidirectional ID map (T7.1 anticipate (c)) — canonical event identity ↔
 * projected session-line uuid.
 *
 * REGENERABLE session metadata: rebuilt from scratch on every cold projection
 * and stored in `CasdkSessionMeta.idMap`. It exists for observability and
 * debugging (which line came from which event), not for correctness —
 * `toolUseId`s are the durable cross-domain identifiers (they appear verbatim
 * in both canonical `tool_call`/`tool_result` payloads and session
 * `tool_use`/`tool_result` blocks), and everything else is re-derivable.
 * Warm-path appends (lines the SDK writes itself) are NOT added here; their
 * canonical counterparts are produced by capture, correlated by toolUseId.
 */

export interface IdMap {
  /** canonical key → session line uuid(s), in projection order. */
  toSession: Record<string, string[]>;
  /** session line uuid → canonical key. */
  toCanonical: Record<string, string>;
}

/**
 * The canonical key of an event for ID-mapping purposes. Stable across
 * rebuilds where the underlying identifier is stable (toolUseIds, message
 * ids); seq-based for events with no payload identity.
 */
export function canonicalEventKey(event: {
  type: string;
  seq?: number;
  payload?: unknown;
}): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "message":
    case "reasoning":
      return `${event.type}:${String(p["id"] ?? `seq-${event.seq}`)}`;
    case "tool_call":
    case "tool_result":
      return `${event.type}:${String(p["toolUseId"] ?? `seq-${event.seq}`)}`;
    default:
      return `${event.type}:seq-${event.seq}`;
  }
}

export function createIdMapBuilder(): {
  add: (canonicalKey: string, lineUuid: string) => void;
  build: () => IdMap;
} {
  const toSession: Record<string, string[]> = {};
  const toCanonical: Record<string, string> = {};
  return {
    add(canonicalKey, lineUuid) {
      (toSession[canonicalKey] ??= []).push(lineUuid);
      toCanonical[lineUuid] = canonicalKey;
    },
    build() {
      return { toSession, toCanonical };
    },
  };
}

/** Recompute `toCanonical` from `toSession` (sanity/repair helper). */
export function invertIdMap(toSession: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, uuids] of Object.entries(toSession)) {
    for (const uuid of uuids) out[uuid] = key;
  }
  return out;
}
