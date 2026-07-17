/**
 * Entity-target → gateway stream-URL resolution for `teaspill logs` (T6.2).
 *
 * The `logs <url>` argument is an entity address, not a stream URL — the CLI
 * derives the timeline stream path (addressing.md §4.2:
 * `/t/<tenant>/agents/<type>/<id>/timeline`) and points it at the gateway's
 * `/streams/*` proxy. A full stream URL (already containing `/streams/`) or an
 * absolute `http(s)://…/timeline` URL is passed through unchanged.
 */

const SHORT_FORM_RE = /^\/a\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/;
const CANONICAL_RE =
  /^\/t\/([a-z0-9][a-z0-9_-]*)\/a\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/;

export interface ResolvedTimeline {
  /** Canonical entity url. */
  entityUrl: string;
  /** Full timeline stream URL through the gateway `/streams/*` proxy. */
  streamUrl: string;
  /** Stream server path (without the gateway origin). */
  streamPath: string;
}

/** Timeline stream server path for a tenant/type/id (addressing.md §4.2). */
export function timelineStreamPath(tenant: string, type: string, id: string): string {
  return `/t/${tenant}/agents/${type}/${id}/timeline`;
}

/**
 * Resolve the `logs` argument to a timeline stream URL through the gateway.
 * Accepts: a canonical entity url, a short-form `/a/<type>/<id>`, or an
 * absolute URL (passed through — assumed to already be a stream URL).
 */
export function resolveTimelineTarget(
  arg: string,
  gatewayUrl: string,
  defaultTenant: string,
): ResolvedTimeline {
  const base = gatewayUrl.replace(/\/+$/, "");

  // Absolute URL already given (e.g. the `streamUrl` echoed by `spawn`).
  if (/^https?:\/\//.test(arg)) {
    const path = new URL(arg).pathname;
    return { entityUrl: arg, streamUrl: arg, streamPath: path };
  }

  const canonical = CANONICAL_RE.exec(arg);
  if (canonical !== null) {
    const [, tenant, type, id] = canonical;
    const streamPath = timelineStreamPath(tenant!, type!, id!);
    return { entityUrl: arg, streamUrl: `${base}/streams${streamPath}`, streamPath };
  }

  const short = SHORT_FORM_RE.exec(arg);
  if (short !== null) {
    const [, type, id] = short;
    const streamPath = timelineStreamPath(defaultTenant, type!, id!);
    return {
      entityUrl: `/t/${defaultTenant}/a/${type}/${id}`,
      streamUrl: `${base}/streams${streamPath}`,
      streamPath,
    };
  }

  throw new Error(
    `not an entity target: ${JSON.stringify(arg)} — expected "/a/<type>/<id>", ` +
      `"/t/<tenant>/a/<type>/<id>", or an absolute stream URL`,
  );
}
