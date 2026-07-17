/**
 * Auth plumbing (D6): everything goes through the gateway with a single
 * `Authorization: Bearer <credential>` header.
 *
 * - **API key** (`tsp_…`) — server-side/full access; works on every route.
 * - **Read token** — a gateway-verified short-lived HS256 JWT minted by the
 *   developer's backend via `mintReadToken` (agents-sdk, T1.4). Honored ONLY
 *   on GET `/streams/*` and `/shapes/*`; writes (`/api/*`) never accept it
 *   (writes never bypass the developer, D6). Pass a function to refresh: it
 *   is re-evaluated per request, so a long-lived subscription picks up fresh
 *   tokens across long-polls — on a 401 the resumable protocol makes
 *   reconnection cheap (T1.4).
 */

export type TeaspillAuth =
  { apiKey: string } | { token: string | (() => string | Promise<string>) };

/**
 * Per-request `Authorization` header value producer, compatible with both
 * `@durable-streams/client` and `@electric-sql/client` dynamic headers.
 */
export function authHeaderValue(auth: TeaspillAuth): () => string | Promise<string> {
  if ("apiKey" in auth) {
    const value = `Bearer ${auth.apiKey}`;
    return () => value;
  }
  const token = auth.token;
  if (typeof token === "string") {
    const value = `Bearer ${token}`;
    return () => value;
  }
  return async () => `Bearer ${await token()}`;
}

/** Headers record for the streaming clients (empty when no auth configured). */
export function authHeaders(
  auth: TeaspillAuth | undefined,
): Record<string, () => string | Promise<string>> {
  return auth === undefined ? {} : { Authorization: authHeaderValue(auth) };
}

/** Resolve the header once (for plain one-shot fetches, e.g. the actions client). */
export async function resolveAuthHeader(
  auth: TeaspillAuth | undefined,
): Promise<Record<string, string>> {
  if (auth === undefined) return {};
  return { Authorization: await authHeaderValue(auth)() };
}
