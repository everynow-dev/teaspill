/**
 * Read-token minting (T1.4, D6: the optional HS256 JWT read path).
 *
 * D6 allows a fast-follow where the gateway verifies short-lived HS256 JWTs
 * (shared secret) carrying a single path-prefix claim, so a browser can read
 * `/streams/*` and `/shapes/*` DIRECTLY — preserving the caching/resumability
 * of the chattiest traffic — without the developer proxying every read.
 * **Writes never bypass the developer** (D6): the gateway only ever honours
 * these tokens on GET `/streams/*` and `/shapes/*`, so a read token can never
 * spawn/send/control an agent.
 *
 * This helper is what a developer's server calls to issue such a token. It is
 * framework-agnostic (just `jose`) and does exactly one thing: sign
 * `{ pfx, iat, exp }` with HS256. The gateway's verifier
 * (`@teaspill/gateway`, `src/jwt.ts`) is the mirror of this file — the two
 * share only the wire contract documented here, not code.
 *
 * ## The `pfx` claim
 *
 * `pfx` is a single path-prefix string. The gateway authorizes a request iff
 * the requested gateway path (e.g. `/streams/t/default/agents/researcher/<id>/timeline`)
 * **starts with** `pfx`. Because both a browser's timeline read and its delta
 * read live under the same entity prefix
 * (`/streams/t/<tenant>/agents/<type>/<id>/`), one token with that prefix
 * covers both `/timeline` and `/deltas` (docs/casdk-mapping.md §8.5).
 *
 * Mint the prefix with a **trailing slash** to get a clean path boundary:
 * `/streams/t/default/agents/researcher/x1/` matches that entity's streams but
 * NOT a sibling `/streams/t/default/agents/researcher/x1extra/…`. Without the
 * slash the prefix would leak across such neighbours.
 *
 * The prefix must be rooted at `/streams/` or `/shapes/` — the gateway applies
 * JWT auth to nothing else, so any other prefix yields a token that can never
 * authorize a request; we reject it at mint time rather than hand back a dud.
 */

import { SignJWT } from "jose";

/** Decoded read-token claims (the payload the gateway verifies). */
export interface ReadTokenClaims {
  /**
   * Single path-prefix the token authorizes, e.g.
   * `/streams/t/default/agents/researcher/<id>/`. The gateway grants a GET on
   * `/streams/*` or `/shapes/*` iff the requested path starts with this.
   */
  pfx: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds); verified with a small clock-skew leeway. */
  exp: number;
}

export interface MintReadTokenOptions {
  /**
   * The path prefix to authorize. Must start with `/streams/` or `/shapes/`.
   * Include a trailing slash for a clean entity boundary (see module docs).
   */
  pfx: string;
  /**
   * Token lifetime in seconds. Keep it SHORT — the resumable stream protocol
   * makes reconnecting with a fresh token cheap, so minutes, not hours, is the
   * right order of magnitude. Must be a positive integer.
   */
  ttlSeconds: number;
  /**
   * The HS256 shared secret. Must match the gateway's `GATEWAY_JWT_SECRET`.
   * Keep it server-side; never ship it to a browser.
   */
  secret: string;
}

const READ_PREFIXES = ["/streams/", "/shapes/"] as const;

/**
 * Mint a short-lived HS256 read token for browser access to `/streams/*` and
 * `/shapes/*`. Returns the compact JWT string.
 *
 * @throws if `pfx` is not rooted at `/streams/` or `/shapes/`, if `ttlSeconds`
 *   is not a positive integer, or if `secret` is empty.
 */
export async function mintReadToken(opts: MintReadTokenOptions): Promise<string> {
  const { pfx, ttlSeconds, secret } = opts;

  if (typeof pfx !== "string" || !READ_PREFIXES.some((p) => pfx.startsWith(p))) {
    throw new Error(
      `mintReadToken: pfx must start with "/streams/" or "/shapes/" (got ${JSON.stringify(pfx)}) — ` +
        "the gateway applies read tokens to nothing else",
    );
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(
      `mintReadToken: ttlSeconds must be a positive integer (got ${JSON.stringify(ttlSeconds)})`,
    );
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("mintReadToken: secret must be a non-empty string");
  }

  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ pfx })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}
