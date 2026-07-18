/**
 * CORS policy for the browser-facing read routes (0001:T1.4).
 *
 * Scope is deliberately narrow: CORS is enabled ONLY for GET (and its OPTIONS
 * preflight) on `/streams/*` and `/shapes/*` — the endpoints a browser reads
 * directly with a JWT read token (0001:D6). `/api/*` and `/registry/*` are never
 * CORS-enabled: writes stay server-side and never bypass the developer.
 *
 * Credentials are intentionally NOT allowed (`Access-Control-Allow-Credentials`
 * is never set): a read token travels in the `Authorization: Bearer` header,
 * not a cookie, so cross-origin reads are non-credentialed. That in turn lets
 * us honour the `*` wildcard origin (the default) and a `*` exposed-header
 * wildcard, which a credentialed request could not use.
 *
 * Origin policy (env GATEWAY_CORS_ALLOW_ORIGINS):
 *  - unset / `*`  → allow any origin (reply `Access-Control-Allow-Origin: *`).
 *    Safe here because the JWT is still required for the actual GET — an open
 *    CORS policy only lets a browser ATTEMPT the read; the token gates it.
 *  - comma list   → reflect the request Origin iff it is on the list, else no
 *    CORS headers (the browser blocks the read).
 */

export type CorsOriginPolicy = "*" | readonly string[];

export function parseCorsOrigins(raw: string | undefined): CorsOriginPolicy {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === "*") return "*";
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The value to send in `Access-Control-Allow-Origin`, or null to deny (send no
 * CORS headers). `*` policy always allows; a list reflects an allowed origin.
 */
export function resolveAllowedOrigin(
  origin: string | undefined,
  policy: CorsOriginPolicy,
): string | null {
  if (policy === "*") return "*";
  if (origin === undefined) return null;
  return policy.includes(origin) ? origin : null;
}
