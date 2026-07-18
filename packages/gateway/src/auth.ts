/**
 * API-key auth (0001:D6: API keys at the gateway for all server-side access; no
 * platform-level permissions/scoping — a key is all-or-nothing).
 *
 * Scheme: a key is opaque high-entropy material (`newApiKey()` mints
 * `tsp_<43 base64url chars>` = 256 bits). Postgres stores only
 * `sha256(key)` hex in `api_keys.hash` (@teaspill/catalog documents exactly
 * this lookup-by-digest design and puts a UNIQUE index on the column).
 *
 * Why sha256 and not bcrypt/argon2 (the 0001:T1.2 task text suggested those):
 * password hashes exist to slow brute-force of LOW-entropy secrets, and are
 * salted — which makes lookup-by-hash impossible, forcing an O(keys) verify
 * per request. API keys here are 256-bit random values: brute-forcing the
 * digest is infeasible, so a fast deterministic digest is the standard,
 * correct choice and preserves the indexed O(1) lookup the catalog schema
 * (0001:T1.3, already frozen) is built around. Recorded as a deliberate deviation
 * in WORKLOG.
 *
 * Comparison is constant-time (`crypto.timingSafeEqual` on the digest of the
 * presented key vs the stored digest) even though the DB lookup is by digest
 * — belt-and-braces, and it keeps the bootstrap-key path (no DB) honest.
 * `revoked_at IS NOT NULL` ⇒ rejected.
 */

import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, hashApiKey, newApiKey, type CatalogDb } from "@teaspill/catalog";

// Key primitives (`newApiKey` mints `tsp_<43 base64url>`; `hashApiKey` = sha256
// hex) are owned by @teaspill/catalog — the package that owns the `api_keys`
// table and the `teaspill keys` CLI (0002:T5.1). Re-exported here so gateway's
// public surface and auth.test.ts are unchanged; there is now ONE canonical
// impl, not a byte-identical copy (0002 G3 consolidation, T1.1 pattern).
export { hashApiKey, newApiKey };

export interface ApiKeyRecord {
  hash: string;
  revokedAt: Date | null;
}

/** Lookup seam so tests (and future stores) can swap Postgres out. */
export interface ApiKeyStore {
  findByHash(hashHex: string): Promise<ApiKeyRecord | null>;
}

export function postgresApiKeyStore(db: CatalogDb): ApiKeyStore {
  return {
    async findByHash(hashHex: string): Promise<ApiKeyRecord | null> {
      const rows = await db
        .select({ hash: apiKeys.hash, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.hash, hashHex))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

function digestsEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export interface Authenticator {
  /** Returns true iff the presented raw key is currently valid. */
  verify(presentedKey: string): Promise<boolean>;
}

export function createAuthenticator(opts: {
  store: ApiKeyStore | null;
  bootstrapApiKey: string | undefined;
}): Authenticator {
  const bootstrapHash = opts.bootstrapApiKey ? hashApiKey(opts.bootstrapApiKey) : null;
  return {
    async verify(presentedKey: string): Promise<boolean> {
      if (presentedKey.length === 0) return false;
      const presentedHash = hashApiKey(presentedKey);
      if (bootstrapHash !== null && digestsEqual(presentedHash, bootstrapHash)) {
        return true;
      }
      if (opts.store === null) return false;
      const record = await opts.store.findByHash(presentedHash);
      if (record === null) return false;
      if (record.revokedAt !== null) return false;
      return digestsEqual(presentedHash, record.hash);
    },
  };
}

/** Extracts the key from `Authorization: Bearer <key>`. Null if absent/malformed. */
export function bearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorizationHeader);
  return m ? m[1]! : null;
}
