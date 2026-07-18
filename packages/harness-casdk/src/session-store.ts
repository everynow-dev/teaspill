/**
 * Durable session storage (0001:T7.1, 0001:D5 layer 2 — Continuation).
 *
 * `CasdkSessionStore` is TEASPILL'S abstraction, keyed by canonical entity
 * url. It persists, per entity:
 * - the session TRANSCRIPT (JSONL lines — projected on cold rebuild, then
 *   extended by the SDK's own dual-write mirror during runs), and
 * - the session METADATA: `{ sessionId, seqStamp, sdkVersion, idMap }` —
 *   the seq stamp is 0001:D5 layer 3's trust-but-verify anchor: the last canonical
 *   seq this session reflects. Stamp == canonical head → warm resume;
 *   anything else → cold rebuild.
 *
 * It reaches the SDK through `toSdkSessionStore` — a facade implementing the
 * SDK's `@alpha` SessionStore contract (`load`/`append`). `load` applies the
 * line-level crash repair (session-lines.ts) so a transcript left with a
 * dangling `tool_use` by a mid-run crash (or a dropped mirror batch) resumes
 * cleanly — live-validated against 0.3.211 (0001:T7.1 experiments A/B/C).
 *
 * Implementations here: in-memory (tests) and filesystem (persistent volume;
 * an object-store impl slots in behind the same interface). The store must be
 * on storage that survives agent-loop restarts for the warm path to pay off —
 * losing it only costs a cold rebuild (0001:D5: projection is the recovery path).
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IdMap } from "./id-map.js";
import type { SessionLine } from "./session-lines.js";
import { parseSessionLines, repairSessionLines, serializeSessionLines } from "./session-lines.js";
import type { SdkSessionKey, SdkSessionStoreLike } from "./sdk-client.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CasdkSessionMeta {
  /** The durable CASDK session id this entity resumes. */
  sessionId: string;
  /**
   * Last canonical seq the session reflects (0001:D5 layer 3). Written by the
   * harness at run end, PREDICTIVELY (base head + returned event count),
   * before the outbox commits — so a crash between save and commit leaves
   * stamp > head, which the next wake reads as a mismatch → cold rebuild.
   * Safe by construction: the stamp can force an unnecessary rebuild, never
   * a wrong resume.
   */
  seqStamp: number;
  /** SDK version the transcript was written under; mismatch → cold rebuild. */
  sdkVersion: string;
  /** Regenerable projection ID map (id-map.ts). */
  idMap: IdMap;
  /** ISO timestamp of the last meta write (observability only). */
  updatedAt: string;
  /**
   * Set just before a WARM run's query starts; cleared at run end. A retried
   * `ctx.run` seeing its own runId here knows the crashed attempt may have
   * already fed the wake into the session — it re-feeds wrapped in an
   * explicit restart marker instead of duplicating the input verbatim.
   */
  pendingRun?: { runId: string };
}

export interface CasdkSessionStore {
  loadMeta(entityId: string): Promise<CasdkSessionMeta | null>;
  saveMeta(entityId: string, meta: CasdkSessionMeta): Promise<void>;
  /** Clear meta (forces cold rebuild on next wake). Missing meta is a no-op. */
  clearMeta(entityId: string): Promise<void>;
  /** Full transcript for a session, or null when absent. */
  loadLines(entityId: string, sessionId: string): Promise<SessionLine[] | null>;
  /** Replace the transcript wholesale (cold projection). */
  replaceLines(entityId: string, sessionId: string, lines: readonly SessionLine[]): Promise<void>;
  /** Append mirrored lines (the SDK dual-write path). */
  appendLines(entityId: string, sessionId: string, lines: readonly SessionLine[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests, ephemeral dev)
// ---------------------------------------------------------------------------

export function createMemorySessionStore(): CasdkSessionStore & {
  /** Test taps. */
  dump(): { meta: Map<string, CasdkSessionMeta>; lines: Map<string, SessionLine[]> };
} {
  const meta = new Map<string, CasdkSessionMeta>();
  const lines = new Map<string, SessionLine[]>();
  const key = (e: string, s: string): string => `${e}${s}`;
  return {
    async loadMeta(entityId) {
      return meta.get(entityId) ?? null;
    },
    async saveMeta(entityId, m) {
      meta.set(entityId, m);
    },
    async clearMeta(entityId) {
      meta.delete(entityId);
    },
    async loadLines(entityId, sessionId) {
      return lines.get(key(entityId, sessionId))?.slice() ?? null;
    },
    async replaceLines(entityId, sessionId, ls) {
      lines.set(key(entityId, sessionId), [...ls]);
    },
    async appendLines(entityId, sessionId, ls) {
      const cur = lines.get(key(entityId, sessionId)) ?? [];
      cur.push(...ls);
      lines.set(key(entityId, sessionId), cur);
    },
    dump() {
      return { meta, lines };
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem implementation (persistent volume)
// ---------------------------------------------------------------------------

/** Entity url → a filesystem-safe directory name (mirrors the SDK's sanitizer). */
export function encodeEntityDir(entityId: string): string {
  return entityId.replace(/[^a-zA-Z0-9]/g, "-");
}

export function createFileSessionStore(rootDir: string): CasdkSessionStore {
  const dirOf = (entityId: string): string => join(rootDir, encodeEntityDir(entityId));
  const metaPath = (entityId: string): string => join(dirOf(entityId), "meta.json");
  const linesPath = (entityId: string, sessionId: string): string =>
    join(dirOf(entityId), "sessions", `${sessionId}.jsonl`);

  const writeAtomic = async (path: string, data: string): Promise<void> => {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  };

  return {
    async loadMeta(entityId) {
      try {
        return JSON.parse(await readFile(metaPath(entityId), "utf8")) as CasdkSessionMeta;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async saveMeta(entityId, meta) {
      await mkdir(dirOf(entityId), { recursive: true });
      await writeAtomic(metaPath(entityId), JSON.stringify(meta, null, 2));
    },
    async clearMeta(entityId) {
      await rm(metaPath(entityId), { force: true });
    },
    async loadLines(entityId, sessionId) {
      try {
        return parseSessionLines(await readFile(linesPath(entityId, sessionId), "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async replaceLines(entityId, sessionId, lines) {
      await mkdir(join(dirOf(entityId), "sessions"), { recursive: true });
      await writeAtomic(linesPath(entityId, sessionId), serializeSessionLines(lines));
    },
    async appendLines(entityId, sessionId, lines) {
      if (lines.length === 0) return;
      await mkdir(join(dirOf(entityId), "sessions"), { recursive: true });
      const { appendFile } = await import("node:fs/promises");
      await appendFile(linesPath(entityId, sessionId), serializeSessionLines(lines), "utf8");
    },
  };
}

// ---------------------------------------------------------------------------
// SDK facade
// ---------------------------------------------------------------------------

export interface SdkFacadeOptions {
  entityId: string;
  newUuid: () => string;
  now?: () => number;
  /** Observes repair activity (metrics/logs). */
  onRepair?: (info: { repairedToolUseIds: string[]; droppedOrphanResults: number }) => void;
}

/**
 * Adapt a `CasdkSessionStore` to the SDK's `@alpha` SessionStore contract for
 * one entity.
 *
 * - `load` — called by the SDK exactly once, pre-spawn, on resume. Returns
 *   the stored transcript with uuid-dedup (the SDK contract says treat `uuid`
 *   as an idempotency key) and the line-level crash REPAIR applied.
 *   Subpath keys (subagent transcripts) return null — no built-in subagents
 *   (0001:D5); a store hit for one would be a misconfiguration.
 * - `append` — the SDK's dual-write mirror (~100ms cadence with
 *   `sessionStoreFlush: 'eager'`). Persisted verbatim, keyed by the SDK's own
 *   session key. NOTE the SDK drops a batch after 3 failed retries
 *   (`mirror_error`) — capture.ts observes that record and the harness taints
 *   the session (forces cold rebuild) rather than trusting a holey mirror.
 */
export function toSdkSessionStore(
  store: CasdkSessionStore,
  opts: SdkFacadeOptions,
): SdkSessionStoreLike {
  const seen = new Set<string>();
  return {
    async load(key: SdkSessionKey) {
      if (key.subpath !== undefined) return null;
      const lines = await store.loadLines(opts.entityId, key.sessionId);
      if (lines === null || lines.length === 0) return null;
      const deduped: SessionLine[] = [];
      const uuids = new Set<string>();
      for (const l of lines) {
        if (typeof l.uuid === "string") {
          if (uuids.has(l.uuid)) continue;
          uuids.add(l.uuid);
          seen.add(l.uuid);
        }
        deduped.push(l);
      }
      const repaired = repairSessionLines(deduped, {
        newUuid: opts.newUuid,
        ...(opts.now !== undefined && { now: opts.now }),
      });
      if (repaired.repairedToolUseIds.length > 0 || repaired.droppedOrphanResults > 0) {
        opts.onRepair?.({
          repairedToolUseIds: repaired.repairedToolUseIds,
          droppedOrphanResults: repaired.droppedOrphanResults,
        });
      }
      return repaired.lines;
    },
    async append(key: SdkSessionKey, entries: SessionLine[]) {
      if (key.subpath !== undefined) return;
      // uuid-dedup across the load prefix + earlier appends (idempotency key).
      const fresh = entries.filter((e) => {
        if (typeof e.uuid !== "string") return true;
        if (seen.has(e.uuid)) return false;
        seen.add(e.uuid);
        return true;
      });
      await store.appendLines(opts.entityId, key.sessionId, fresh);
    },
  };
}
