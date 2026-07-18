/**
 * Agent catalog over Electric shapes (0001:T5.2, thin by design): subscribes to
 * the `entities` table (0001:T1.3) through the gateway's `/shapes/*` proxy (0001:T1.2)
 * with `@electric-sql/client`. The catalog is 0001:D1's UI-facing registry —
 * entity rows by type/parent/status/tenant; per-tag subscriptions go through
 * the normalized `entity_tags` table (addressing.md §8 Rec 2).
 *
 * Filters are deliberately the scalar-column equalities the addressing
 * scheme was designed around (`type = $1`, `parent = $1`, `status = $1`,
 * `tenant = $1`) — positional params, never string interpolation. An escape
 * hatch (`where`) exists for anything richer.
 */

import { Shape, ShapeStream, type Row, type ShapeStreamInterface } from "@electric-sql/client";
import { authHeaders, type TeaspillAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityStatus = "active" | "idle" | "archived";

/** One `entities` catalog row (0001:T1.3 columns, camel-cased). */
export interface EntityRow {
  url: string;
  tenant: string;
  type: string;
  status: EntityStatus;
  tags: unknown;
  parent: string | null;
  /** Confirmed head seq (0001:A6 #5: a monotonic floor, not necessarily exact). */
  headSeq: number | null;
  /** Latest state_snapshot position (fast-join input, docs/streams.md §2.3). */
  snapshotOffset: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Scalar-equality filters (AND-combined). All optional. */
export interface CatalogFilter {
  type?: string;
  parent?: string;
  status?: EntityStatus;
  tenant?: string;
}

export interface AgentCatalogOptions {
  /** Gateway origin, e.g. `https://gateway.example.com`. */
  baseUrl: string | URL;
  filter?: CatalogFilter;
  /** Escape hatch: raw where clause with positional `$i` params. Overrides `filter`. */
  where?: { clause: string; params?: string[] };
  /** Shape table (default `entities`; `entity_tags` for tag subscriptions). */
  table?: string;
  auth?: TeaspillAuth;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

export interface AgentCatalogState {
  rows: EntityRow[];
  isUpToDate: boolean;
  lastError: unknown;
}

export interface AgentCatalog {
  getState(): AgentCatalogState;
  subscribe(listener: (state: AgentCatalogState) => void): () => void;
  /** Resolves after the initial sync completes. */
  untilReady(): Promise<AgentCatalogState>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a server)
// ---------------------------------------------------------------------------

/** Build the Electric `where`/`params` pair for the scalar filters. */
export function buildCatalogWhere(filter: CatalogFilter | undefined): {
  where?: string;
  params?: string[];
} {
  if (filter === undefined) return {};
  const clauses: string[] = [];
  const params: string[] = [];
  const push = (column: string, value: string): void => {
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };
  if (filter.tenant !== undefined) push("tenant", filter.tenant);
  if (filter.type !== undefined) push("type", filter.type);
  if (filter.parent !== undefined) push("parent", filter.parent);
  if (filter.status !== undefined) push("status", filter.status);
  if (clauses.length === 0) return {};
  return { where: clauses.join(" AND "), params };
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v !== "") return Number(v);
  return null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Map a raw shape row (snake_case DB columns) onto EntityRow. */
export function toEntityRow(row: Row<unknown>): EntityRow {
  return {
    url: String(row["url"]),
    tenant: String(row["tenant"]),
    type: String(row["type"]),
    status: String(row["status"]) as EntityStatus,
    tags: row["tags"] ?? null,
    parent: row["parent"] === null || row["parent"] === undefined ? null : String(row["parent"]),
    headSeq: toNum(row["head_seq"]),
    snapshotOffset: toNum(row["snapshot_offset"]),
    createdAt: toStr(row["created_at"]),
    updatedAt: toStr(row["updated_at"]),
  };
}

/** The gateway shape endpoint (proxied to Electric's `/v1/shape`, 0001:T1.2). */
export function catalogShapeUrl(baseUrl: string | URL): string {
  return `${String(baseUrl).replace(/\/+$/, "")}/shapes/v1/shape`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createAgentCatalog(options: AgentCatalogOptions): AgentCatalog {
  const controller = new AbortController();
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const filterPair =
    options.where !== undefined
      ? {
          where: options.where.clause,
          ...(options.where.params !== undefined ? { params: options.where.params } : {}),
        }
      : buildCatalogWhere(options.filter);

  const stream = new ShapeStream({
    url: catalogShapeUrl(options.baseUrl),
    params: {
      table: options.table ?? "entities",
      ...(filterPair.where !== undefined ? { where: filterPair.where } : {}),
      ...(filterPair.params !== undefined ? { params: filterPair.params } : {}),
    },
    headers: authHeaders(options.auth),
    signal: controller.signal,
    ...(options.fetch !== undefined ? { fetchClient: options.fetch } : {}),
    onError: (error) => {
      state = { ...state, lastError: error };
      options.onError?.(error);
      notify();
      // Keep syncing (the Electric client stops when the handler returns void).
      return {};
    },
  });
  // Cast: the Electric client's own types don't satisfy this repo's
  // `exactOptionalPropertyTypes` when a ShapeStream meets ShapeStreamInterface.
  const shape = new Shape(stream as unknown as ShapeStreamInterface<Row<unknown>>);

  let state: AgentCatalogState = { rows: [], isUpToDate: false, lastError: null };
  const listeners = new Set<(s: AgentCatalogState) => void>();
  const notify = (): void => {
    for (const l of listeners) l(state);
  };

  const unsubscribeShape = shape.subscribe(({ rows }) => {
    state = { ...state, rows: rows.map(toEntityRow), isUpToDate: shape.isUpToDate };
    notify();
  });

  const ready: Promise<AgentCatalogState> = shape.rows
    .then((rows) => {
      // First load may complete before the subscription callback fires.
      if (!state.isUpToDate) {
        state = { ...state, rows: rows.map(toEntityRow), isUpToDate: true };
        notify();
      }
      return state;
    })
    .catch((error: unknown) => {
      state = { ...state, lastError: error };
      notify();
      return state;
    });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    untilReady: () => ready,
    close: () => {
      unsubscribeShape();
      controller.abort();
    },
  };
}
