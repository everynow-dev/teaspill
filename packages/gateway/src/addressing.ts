/**
 * Entity addressing (ported subset of docs/addressing.md §9).
 *
 * NOTE ON OWNERSHIP: addressing.md says these derivation functions belong in
 * `packages/schema` ("dropped in by a follow-up task"). At the time T1.2 was
 * built, `@teaspill/schema` did not yet contain them (its index.ts says the
 * same), so the gateway carries the minimal subset it needs, ported verbatim
 * from the reference implementation. When a follow-up task lands them in
 * @teaspill/schema, delete this file and import from there — the function
 * names and signatures here intentionally match the reference exactly to
 * make that a mechanical change.
 */

import { ulid } from "ulidx";

/** Per-deployment tenant id (D8: a tenant is a deployment). Config: TEASPILL_TENANT. */
export const DEFAULT_TENANT = "default";

export const ENTITY_MARKER = "a"; // /t/<tenant>/a/<type>/<id>
export const STREAM_COLLECTION = "agents"; // /t/<tenant>/agents/<type>/<id>/...
export const GATEWAY_STREAMS_PREFIX = "/streams";

const seg = (max: number): RegExp => new RegExp(`^[a-z0-9][a-z0-9_-]{0,${max - 1}}$`);

export const TENANT_RE = seg(32);
export const TYPE_RE = seg(48);
export const ID_RE = seg(64);

export interface EntityRef {
  tenant: string;
  type: string;
  id: string;
}

/** A resolved Restate virtual-object target. */
export interface RestateTarget {
  service: string;
  key: string;
}

/** Error subclass so routes can map addressing failures to HTTP 400. */
export class AddressingError extends Error {}

function assertSeg(re: RegExp, v: string, what: string): void {
  if (typeof v !== "string" || !re.test(v)) {
    throw new AddressingError(`invalid ${what}: ${JSON.stringify(v)} (must match ${re})`);
  }
}

/** Canonical entity url: `/t/<tenant>/a/<type>/<id>`. */
export function entityUrl(tenant: string, type: string, id: string): string {
  assertSeg(TENANT_RE, tenant, "tenant");
  assertSeg(TYPE_RE, type, "type");
  assertSeg(ID_RE, id, "id");
  return `/t/${tenant}/${ENTITY_MARKER}/${type}/${id}`;
}

const ENTITY_URL_RE =
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

/** Fresh instance id: lowercase ULID (time-sortable, 26 chars, url-safe). */
export function newInstanceId(): string {
  return ulid().toLowerCase();
}

/** Validate a caller-supplied id (deterministic spawn). Throws if invalid. */
export function assertInstanceId(id: string): void {
  assertSeg(ID_RE, id, "id");
}

export function timelineStreamPath(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url);
  return `/t/${tenant}/${STREAM_COLLECTION}/${type}/${id}/timeline`;
}

/** Server stream key -> gateway URL a client GETs. */
export function gatewayStreamUrl(streamPath: string): string {
  return `${GATEWAY_STREAMS_PREFIX}${streamPath}`;
}

/** Agent virtual object: service `agent.<type>`, key `<id>` (docs/addressing.md §6). */
export function restateAgentKey(url: string): RestateTarget {
  const { type, id } = parseEntityUrl(url);
  return { service: `agent.${type}`, key: id };
}
