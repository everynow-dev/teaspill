/**
 * Entity addressing (https://teaspill.everynow.dev/reference/addressing) — canonical derivation functions
 * for entity urls, stream paths, workspace keys, and the Restate key mapping.
 *
 * Promoted here from duplicate ports in `packages/gateway/src/addressing.ts`
 * and the regex subset in `packages/frontend-sdk/src/actions.ts`
 * (0001:T1.2 + 0001:T5.2 carry-forward, closed by 0002:T1.1). Both packages
 * now import from here; do not re-duplicate these functions locally.
 *
 * Pure, dependency-light (only `ulidx` for id generation). No I/O, no clock
 * except `newInstanceId`. Every function validates its inputs and throws
 * `AddressingError` on malformed identifiers — malformed identifiers must
 * never reach the catalog, Restate, or the streams server.
 */

import { ulid } from "ulidx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-deployment tenant id (0001:D8: a tenant is a deployment). Config: TEASPILL_TENANT. */
export const DEFAULT_TENANT = "default";

export const ENTITY_MARKER = "a"; // /t/<tenant>/a/<type>/<id>
export const STREAM_COLLECTION = "agents"; // /t/<tenant>/agents/<type>/<id>/...
export const WORKSPACE_COLLECTION = "workspaces";
export const GATEWAY_STREAMS_PREFIX = "/streams";

const seg = (max: number): RegExp => new RegExp(`^[a-z0-9][a-z0-9_-]{0,${max - 1}}$`);

export const TENANT_RE = seg(32);
export const TYPE_RE = seg(48);
export const ID_RE = seg(64);
export const WORKSPACE_NAME_RE = seg(64);
export const CRON_KEY_RE = seg(64);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityRef {
  tenant: string;
  type: string;
  id: string;
}

export interface WorkspaceRef {
  tenant: string;
  name: string;
}

/** A resolved Restate virtual-object target. */
export interface RestateTarget {
  service: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Error subclass so callers can map addressing failures to HTTP 400 etc. */
export class AddressingError extends Error {}

function assertSeg(re: RegExp, v: string, what: string): void {
  if (typeof v !== "string" || !re.test(v)) {
    throw new AddressingError(`invalid ${what}: ${JSON.stringify(v)} (must match ${re})`);
  }
}

// ---------------------------------------------------------------------------
// Entity URL  (== entities.url pk == entityId)
// ---------------------------------------------------------------------------

/** Canonical entity url: `/t/<tenant>/a/<type>/<id>`. */
export function entityUrl(tenant: string, type: string, id: string): string {
  assertSeg(TENANT_RE, tenant, "tenant");
  assertSeg(TYPE_RE, type, "type");
  assertSeg(ID_RE, id, "id");
  return `/t/${tenant}/${ENTITY_MARKER}/${type}/${id}`;
}

export const ENTITY_URL_RE =
  /^\/t\/([a-z0-9][a-z0-9_-]*)\/a\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/;

/** Parse a canonical entity url back into its parts (revalidates lengths). */
export function parseEntityUrl(url: string): EntityRef {
  const m = ENTITY_URL_RE.exec(url);
  if (!m) throw new AddressingError(`not a canonical entity url: ${JSON.stringify(url)}`);
  const tenant = m[1]!;
  const type = m[2]!;
  const id = m[3]!;
  assertSeg(TENANT_RE, tenant, "tenant");
  assertSeg(TYPE_RE, type, "type");
  assertSeg(ID_RE, id, "id");
  return { tenant, type, id };
}

export function isEntityUrl(url: string): boolean {
  try {
    parseEntityUrl(url);
    return true;
  } catch {
    return false;
  }
}

export const SHORT_FORM_RE = /^\/a\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/;

/** Canonical url -> gateway short form `/a/<type>/<id>` (default tenant only). */
export function toHttpForm(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url);
  return tenant === DEFAULT_TENANT ? `/${ENTITY_MARKER}/${type}/${id}` : url;
}

/** Gateway short form (or already-canonical url) -> canonical url. */
export function fromHttpForm(path: string, tenant: string = DEFAULT_TENANT): string {
  const m = SHORT_FORM_RE.exec(path);
  if (m) return entityUrl(tenant, m[1]!, m[2]!);
  return parseEntityUrl(path) && path; // throws if neither form
}

// ---------------------------------------------------------------------------
// Instance ids
// ---------------------------------------------------------------------------

/** Fresh instance id: lowercase ULID (time-sortable, 26 chars, url-safe). */
export function newInstanceId(): string {
  return ulid().toLowerCase();
}

/** Validate a caller-supplied id (deterministic spawn). Throws if invalid. */
export function assertInstanceId(id: string): void {
  assertSeg(ID_RE, id, "id");
}

// ---------------------------------------------------------------------------
// Stream paths (durable-streams server keys; prefix with
// GATEWAY_STREAMS_PREFIX for the client-facing URL)
// ---------------------------------------------------------------------------

export function timelineStreamPath(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url);
  return `/t/${tenant}/${STREAM_COLLECTION}/${type}/${id}/timeline`;
}

export function deltasStreamPath(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url);
  return `/t/${tenant}/${STREAM_COLLECTION}/${type}/${id}/deltas`;
}

/** Server stream key -> gateway URL a client GETs. */
export function gatewayStreamUrl(streamPath: string): string {
  return `${GATEWAY_STREAMS_PREFIX}${streamPath}`;
}

// ---------------------------------------------------------------------------
// Workspaces (0001:D4)
// ---------------------------------------------------------------------------

/** Workspace key: `<tenant>/<name>`. */
export function workspaceKey(tenant: string, name: string): string {
  assertSeg(TENANT_RE, tenant, "tenant");
  assertSeg(WORKSPACE_NAME_RE, name, "workspace name");
  return `${tenant}/${name}`;
}

export function parseWorkspaceKey(key: string): WorkspaceRef {
  const i = key.indexOf("/");
  if (i <= 0) throw new AddressingError(`invalid workspace key: ${JSON.stringify(key)}`);
  const tenant = key.slice(0, i);
  const name = key.slice(i + 1);
  assertSeg(TENANT_RE, tenant, "tenant");
  assertSeg(WORKSPACE_NAME_RE, name, "workspace name");
  return { tenant, name };
}

/** Default private (1:1) workspace key for an entity. */
export function privateWorkspaceKey(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url);
  return workspaceKey(tenant, `${ENTITY_MARKER}-${type}-${id}`);
}

export function workspaceStdoutStreamPath(key: string): string {
  const { tenant, name } = parseWorkspaceKey(key);
  return `/t/${tenant}/${WORKSPACE_COLLECTION}/${name}/stdout`;
}

export function workspaceExecStdoutStreamPath(key: string, runId: string): string {
  const { tenant, name } = parseWorkspaceKey(key);
  assertSeg(ID_RE, runId, "runId");
  return `/t/${tenant}/${WORKSPACE_COLLECTION}/${name}/exec/${runId}/stdout`;
}

// ---------------------------------------------------------------------------
// Restate key mapping (0001:D2/0001:D4). Tenant is implicit (0001:D8: one
// tenant per deployment).
// ---------------------------------------------------------------------------

/** Agent virtual object: service `agent.<type>` (type in the service name because
 *  each defineAgent type registers its own Restate service, 0001:T6.1), key `<id>`. */
export function restateAgentKey(url: string): RestateTarget {
  const { type, id } = parseEntityUrl(url);
  return { service: `agent.${type}`, key: id };
}

/** Steerbox virtual object: service `steer`, key = full canonical entity url. */
export function steerKey(url: string): RestateTarget {
  parseEntityUrl(url); // validate
  return { service: "steer", key: url };
}

/** Workspace virtual object: service `workspace`, key `<tenant>/<name>`. */
export function restateWorkspaceKey(key: string): RestateTarget {
  parseWorkspaceKey(key); // validate
  return { service: "workspace", key };
}

/** Cron virtual object: service `cron`, key `<name>`. */
export function restateCronKey(name: string): RestateTarget {
  assertSeg(CRON_KEY_RE, name, "cron key");
  return { service: "cron", key: name };
}

// ---------------------------------------------------------------------------
// durable-streams outbox producer identity (0001:D3 / 0001:T2.2)
// ---------------------------------------------------------------------------

/** Producer-Id for an entity's timeline outbox == the entity url. */
export function timelineProducerId(url: string): string {
  parseEntityUrl(url); // validate
  return url;
}
