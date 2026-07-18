/**
 * @teaspill/catalog — API-key minting, hashing, and admin store (0002:T5.1).
 *
 * Catalog owns the `api_keys` table (0001:D6), so it is the canonical home for
 * the key primitives that must agree with the gateway's verifier. The token
 * format and hash MUST match `packages/gateway/src/auth.ts` exactly, or minted
 * keys will not authenticate:
 *
 *   - mint:  `tsp_<43 base64url chars>` = 32 random bytes = 256 bits of entropy
 *   - store: `sha256(token)` lowercase hex — the ONLY thing persisted; the raw
 *            token is shown once at creation and is NOT recoverable.
 *
 * (`gateway/src/auth.ts` re-exports `newApiKey`/`hashApiKey` FROM this module —
 * this is the single canonical impl. The `keys.test.ts` format pin still guards
 * the wire format against accidental change. Consolidated in 0002 G3.)
 *
 * These are operator-context functions: they need a direct DB connection (the
 * `teaspill keys` CLI, operator scripts), NOT a gateway route — the gateway has
 * no admin-auth tier and adding one is out of scope (0002:T5.1).
 */

import { createHash, randomBytes } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import { apiKeys } from "./schema.js";
import type { CatalogDb } from "./client.js";

/** The `tsp_` prefix every teaspill API key carries (matches the gateway). */
export const API_KEY_PREFIX = "tsp_";

/**
 * Mint fresh key material: `tsp_` + 32 random bytes (256 bits) as base64url.
 * The caller stores only `hashApiKey(token)`; the plaintext is shown once.
 */
export function newApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Digest stored in `api_keys.hash`: lowercase sha256 hex of the raw token. */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The metadata `ls`/`revoke` surface — never includes hash or plaintext. */
export interface ApiKeyListRow {
  id: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

const LIST_COLUMNS = {
  id: apiKeys.id,
  label: apiKeys.label,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
} as const;

/** Result of `createApiKey`: the plaintext token appears here exactly once. */
export interface CreatedApiKey {
  id: string;
  /** The plaintext `tsp_…` token — print once, never persist or log. */
  token: string;
  label: string | null;
  createdAt: Date;
}

/**
 * Mint a key, store only its sha256 hash, and return the row + plaintext token.
 * The token is generated here, hashed, and the hash is what lands in Postgres —
 * the caller is responsible for showing the token once and dropping it.
 */
export async function createApiKey(
  db: CatalogDb,
  opts: { label?: string | null } = {},
): Promise<CreatedApiKey> {
  const token = newApiKey();
  const hash = hashApiKey(token);
  const [row] = await db
    .insert(apiKeys)
    .values({ hash, label: opts.label ?? null })
    .returning({ id: apiKeys.id, label: apiKeys.label, createdAt: apiKeys.createdAt });
  if (row === undefined) throw new Error("failed to insert api key");
  return { id: row.id, token, label: row.label, createdAt: row.createdAt };
}

/** List key metadata (id, label, created_at, revoked_at) — no secret material. */
export async function listApiKeys(db: CatalogDb): Promise<ApiKeyListRow[]> {
  return db.select(LIST_COLUMNS).from(apiKeys).orderBy(apiKeys.createdAt);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PREFIX_RE = /^[0-9a-f]+(?:-[0-9a-f]+)*$/i;

/**
 * How a revoke selector is interpreted. The `api_keys` table stores no prefix
 * of the key material (only the sha256 hash), so the identifiers we can revoke
 * by are: the plaintext token (hashed and matched by hash), the full key id
 * (uuid), or a key-id PREFIX (hex/dash) for ergonomics. There is deliberately
 * no "key prefix" mode — nothing in the row exposes the token's leading chars.
 */
export type KeySelector =
  | { kind: "token"; hash: string }
  | { kind: "id"; id: string }
  | { kind: "idPrefix"; prefix: string };

/** Classify a revoke selector (pure — no DB). Throws on an unrecognized shape. */
export function classifyKeySelector(selector: string): KeySelector {
  const s = selector.trim();
  if (s === "") throw new Error("empty key selector");
  if (s.startsWith(API_KEY_PREFIX)) return { kind: "token", hash: hashApiKey(s) };
  if (UUID_RE.test(s)) return { kind: "id", id: s.toLowerCase() };
  if (ID_PREFIX_RE.test(s)) return { kind: "idPrefix", prefix: s.toLowerCase() };
  throw new Error(
    `unrecognized key selector ${JSON.stringify(selector)} — expected a tsp_ token, ` +
      `a full key id (uuid), or a key-id prefix (hex)`,
  );
}

/**
 * Resolve a selector to exactly one key row. Throws if it matches zero rows or
 * (for a prefix) more than one — the caller must disambiguate with a longer
 * prefix or the full id.
 */
export async function resolveApiKeyRow(
  db: CatalogDb,
  selector: string,
): Promise<ApiKeyListRow> {
  const sel = classifyKeySelector(selector);
  let where: SQL;
  if (sel.kind === "token") where = eq(apiKeys.hash, sel.hash);
  else if (sel.kind === "id") where = eq(apiKeys.id, sel.id);
  else where = sql`${apiKeys.id}::text like ${sel.prefix + "%"}`;

  const rows = await db.select(LIST_COLUMNS).from(apiKeys).where(where);
  if (rows.length === 0) throw new Error(`no api key matches ${JSON.stringify(selector)}`);
  if (rows.length > 1) {
    throw new Error(
      `ambiguous key selector ${JSON.stringify(selector)} — matches ${rows.length} keys; ` +
        `use the full id`,
    );
  }
  return rows[0]!;
}

/** Outcome of a revoke: the (now-)revoked row, and whether it was already revoked. */
export interface RevokeResult {
  row: ApiKeyListRow;
  alreadyRevoked: boolean;
}

/**
 * Revoke a key by selector: set `revoked_at` (soft delete — the gateway rejects
 * any row with `revoked_at IS NOT NULL`). Idempotent: revoking an already-revoked
 * key leaves the original timestamp and reports `alreadyRevoked`.
 */
export async function revokeApiKey(
  db: CatalogDb,
  selector: string,
  now: Date = new Date(),
): Promise<RevokeResult> {
  const existing = await resolveApiKeyRow(db, selector);
  if (existing.revokedAt !== null) return { row: existing, alreadyRevoked: true };
  const [updated] = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(eq(apiKeys.id, existing.id))
    .returning(LIST_COLUMNS);
  return { row: updated ?? existing, alreadyRevoked: false };
}
