/**
 * Workspace addressing helpers (0001:T4.1) — ported from https://teaspill.everynow.dev/reference/addressing
 * reference implementation.
 *
 * TODO(move-to-schema): https://teaspill.everynow.dev/reference/addressing destines these derivations for
 * `@teaspill/schema`; the gateway (0001:T1.2) and coordination (0001:T2.1) carry the
 * same interim ports. When the schema drop-in lands, this module becomes a
 * re-export.
 */

export const DEFAULT_TENANT = "default";
export const WORKSPACE_COLLECTION = "workspaces";

const seg = (max: number): RegExp => new RegExp(`^[a-z0-9][a-z0-9_-]{0,${max - 1}}$`);

export const TENANT_RE = seg(32);
export const WORKSPACE_NAME_RE = seg(64);
export const EXEC_ID_RE = seg(64);

export interface WorkspaceRef {
  tenant: string;
  name: string;
}

function assertSeg(re: RegExp, v: string, what: string): void {
  if (typeof v !== "string" || !re.test(v)) {
    throw new Error(`invalid ${what}: ${JSON.stringify(v)} (must match ${re})`);
  }
}

/** Workspace key `<tenant>/<name>` (0001:D4/0001:A3 — the Restate `workspace` object key). */
export function workspaceKey(tenant: string, name: string): string {
  assertSeg(TENANT_RE, tenant, "tenant");
  assertSeg(WORKSPACE_NAME_RE, name, "workspace name");
  return `${tenant}/${name}`;
}

/** Parse (and validate) a workspace key back into `{ tenant, name }`. */
export function parseWorkspaceKey(key: string): WorkspaceRef {
  const i = key.indexOf("/");
  if (i <= 0) throw new Error(`invalid workspace key: ${JSON.stringify(key)}`);
  const tenant = key.slice(0, i);
  const name = key.slice(i + 1);
  assertSeg(TENANT_RE, tenant, "tenant");
  assertSeg(WORKSPACE_NAME_RE, name, "workspace name");
  return { tenant, name };
}

/** Per-workspace rolling stdout stream path (addressing §4.3, coarse option). */
export function workspaceStdoutStreamPath(key: string): string {
  const { tenant, name } = parseWorkspaceKey(key);
  return `/t/${tenant}/${WORKSPACE_COLLECTION}/${name}/stdout`;
}

/**
 * Per-exec stdout stream path (addressing §4.3, recommended option — 0001:T4.1
 * CHOSE this granularity): the `streamRef` returned by `exec` names a stream
 * that is immutable once the exec completes, so clients can cache/replay it
 * without interleaving concerns, and retention decisions stay per-exec.
 */
export function workspaceExecStdoutStreamPath(key: string, execId: string): string {
  const { tenant, name } = parseWorkspaceKey(key);
  assertSeg(EXEC_ID_RE, execId, "execId");
  return `/t/${tenant}/${WORKSPACE_COLLECTION}/${name}/exec/${execId}/stdout`;
}

/**
 * Derive a replay-stable exec id from a Restate invocation id (mixed-case,
 * `inv_…`-shaped) into the addressing id charset (`^[a-z0-9][a-z0-9_-]*$`,
 * ≤64). Deterministic — the invocation id is stable across retry attempts of
 * the same invocation, so a retried `exec` wake reuses the same exec id (the
 * host's dedup key) and the same stream path.
 */
export function execIdFromInvocationId(invocationId: string): string {
  const cleaned = invocationId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const body = cleaned.replace(/^[_-]+/, "");
  const id = (body.length > 0 ? `x-${body}` : "x-exec").slice(0, 64);
  assertSeg(EXEC_ID_RE, id, "execId");
  return id;
}

/** Validate a caller-supplied exec id. Throws on malformed input. */
export function assertExecId(execId: string): void {
  assertSeg(EXEC_ID_RE, execId, "execId");
}
