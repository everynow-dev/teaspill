/**
 * HS256 read-token verification (T1.4, D6: the optional JWT read path).
 *
 * This is the gateway-side mirror of `@teaspill/agents-sdk`'s `mintReadToken`.
 * The two share only the wire contract, never code: a compact HS256 JWT whose
 * payload carries a single path-prefix claim `pfx` plus `exp`. The gateway
 * honours such a token ONLY on GET `/streams/*` and `/shapes/*` (wired in
 * `app.ts`); writes never bypass the developer (D6).
 *
 * Verification uses `jose`:
 *  - algorithm is pinned to HS256 (`algorithms: ['HS256']`) — an attacker
 *    cannot downgrade to `alg: none` or swap to an asymmetric alg;
 *  - `exp` is checked with a small **clock-skew leeway** (`clockTolerance`,
 *    default 60 s, GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS) so a token that just
 *    tipped over the boundary against a slightly-fast/slow clock is not
 *    spuriously rejected mid-long-poll;
 *  - an expired-beyond-leeway or otherwise-invalid token yields a typed
 *    failure the caller turns into a 401 telling the client to reconnect with
 *    a fresh token (cheap, because the stream protocol is resumable).
 */

import { errors, jwtVerify } from "jose";

export type ReadTokenResult =
  | { ok: true; pfx: string }
  | { ok: false; reason: "expired" | "invalid" };

export interface ReadTokenVerifier {
  verify(token: string): Promise<ReadTokenResult>;
}

/** Cheap shape check: a compact JWS is three base64url segments split by `.`. */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export function createReadTokenVerifier(opts: {
  secret: string;
  clockToleranceSeconds: number;
}): ReadTokenVerifier {
  const key = new TextEncoder().encode(opts.secret);
  return {
    async verify(token: string): Promise<ReadTokenResult> {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          clockTolerance: opts.clockToleranceSeconds,
        });
        const pfx = payload.pfx;
        if (typeof pfx !== "string" || pfx.length === 0) {
          return { ok: false, reason: "invalid" };
        }
        return { ok: true, pfx };
      } catch (err) {
        if (err instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
        return { ok: false, reason: "invalid" };
      }
    },
  };
}
