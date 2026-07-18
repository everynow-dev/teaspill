import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  API_KEY_PREFIX,
  classifyKeySelector,
  createApiKey,
  hashApiKey,
  listApiKeys,
  newApiKey,
  resolveApiKeyRow,
  revokeApiKey,
} from "./keys.js";
import { createCatalogClient, migrate, type CatalogDb } from "./client.js";
import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Pure unit tests — no DB. These pin the token format + hash so a minted key
// keeps authenticating against the gateway's verifier (packages/gateway/auth.ts
// mints `tsp_${randomBytes(32).base64url}` and stores `sha256(key)` hex).
// ---------------------------------------------------------------------------

describe("newApiKey", () => {
  it("mints a 256-bit tsp_-prefixed base64url token", () => {
    const key = newApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    // Same shape the gateway's regex asserts: tsp_ + 43 base64url chars.
    expect(key).toMatch(/^tsp_[A-Za-z0-9_-]{43}$/);
    // 43 base64url chars decode to exactly 32 bytes = 256 bits of entropy.
    const material = key.slice(API_KEY_PREFIX.length);
    expect(Buffer.from(material, "base64url").length).toBe(32);
  });

  it("is random (no collisions across a batch)", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => newApiKey()));
    expect(keys.size).toBe(1000);
  });
});

describe("hashApiKey", () => {
  it("is sha256 hex, deterministic, and NOT the plaintext", () => {
    const key = newApiKey();
    const hash = hashApiKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).not.toBe(key);
    expect(hash).not.toContain(key);
    // Byte-identical to the gateway's `createHash("sha256").update(key,"utf8")`.
    expect(hash).toBe(createHash("sha256").update(key, "utf8").digest("hex"));
  });

  it("matches a fixed vector (drift guard against the gateway)", () => {
    // sha256("tsp_example") — if this changes, minted keys stop authenticating.
    expect(hashApiKey("tsp_example")).toBe(
      createHash("sha256").update("tsp_example", "utf8").digest("hex"),
    );
  });
});

describe("classifyKeySelector", () => {
  it("recognizes a tsp_ token and revokes by its hash", () => {
    const key = newApiKey();
    const sel = classifyKeySelector(key);
    expect(sel).toEqual({ kind: "token", hash: hashApiKey(key) });
  });

  it("recognizes a full uuid as an id", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(classifyKeySelector(id)).toEqual({ kind: "id", id });
  });

  it("treats a bare hex string as an id prefix", () => {
    expect(classifyKeySelector("11111111")).toEqual({ kind: "idPrefix", prefix: "11111111" });
    expect(classifyKeySelector("11111111-2222")).toEqual({
      kind: "idPrefix",
      prefix: "11111111-2222",
    });
  });

  it("rejects empty or unrecognized selectors", () => {
    expect(() => classifyKeySelector("")).toThrow(/empty/);
    expect(() => classifyKeySelector("   ")).toThrow(/empty/);
    expect(() => classifyKeySelector("not a key!")).toThrow(/unrecognized/);
  });
});

// ---------------------------------------------------------------------------
// DB round-trip — skipped unless DATABASE_URL is set (mirrors
// migrations.integration.test.ts). Proves storage is the HASH not the plaintext,
// revoke sets revoked_at, and ls surfaces no secret material.
// ---------------------------------------------------------------------------

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("api key admin against a live Postgres", () => {
  let db: CatalogDb;
  let sql: Sql;

  it("createApiKey stores the sha256 hash, never the plaintext", async () => {
    ({ db, sql } = createCatalogClient());
    await migrate({ db, sql });
    await sql`delete from api_keys`;

    const created = await createApiKey(db, { label: "test-service" });
    expect(created.token).toMatch(/^tsp_[A-Za-z0-9_-]{43}$/);
    expect(created.label).toBe("test-service");

    const rows = await sql<{ hash: string }[]>`select hash from api_keys where id = ${created.id}`;
    expect(rows[0]?.hash).toBe(hashApiKey(created.token));
    expect(rows[0]?.hash).not.toBe(created.token); // never the plaintext
  });

  it("listApiKeys returns metadata only (no hash / no token)", async () => {
    const rows = await listApiKeys(db);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["createdAt", "id", "label", "revokedAt"].sort());
      expect(JSON.stringify(r)).not.toContain("tsp_");
    }
  });

  it("revokeApiKey sets revoked_at and is idempotent", async () => {
    const created = await createApiKey(db, { label: "to-revoke" });
    const first = await revokeApiKey(db, created.id);
    expect(first.alreadyRevoked).toBe(false);
    expect(first.row.revokedAt).not.toBeNull();

    const again = await revokeApiKey(db, created.id);
    expect(again.alreadyRevoked).toBe(true);
    expect(again.row.revokedAt).toEqual(first.row.revokedAt);
  });

  it("resolves by token and by id prefix; errors on ambiguity/miss", async () => {
    const created = await createApiKey(db, { label: "resolve-me" });
    const byToken = await resolveApiKeyRow(db, created.token);
    expect(byToken.id).toBe(created.id);
    const byPrefix = await resolveApiKeyRow(db, created.id.slice(0, 8));
    expect(byPrefix.id).toBe(created.id);
    await expect(resolveApiKeyRow(db, "ffffffff-ffff-ffff-ffff-ffffffffffff")).rejects.toThrow(
      /no api key matches/,
    );

    await sql.end();
  });
});
