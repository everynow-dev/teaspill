import { describe, expect, it } from "vitest";
import {
  bearerToken,
  createAuthenticator,
  hashApiKey,
  newApiKey,
  type ApiKeyRecord,
  type ApiKeyStore,
} from "./auth.js";

function storeOf(records: ApiKeyRecord[]): ApiKeyStore {
  return {
    findByHash: (hashHex) => Promise.resolve(records.find((r) => r.hash === hashHex) ?? null),
  };
}

describe("api-key auth", () => {
  it("hashes deterministically to sha256 hex (the api_keys.hash contract)", () => {
    expect(hashApiKey("abc")).toBe(hashApiKey("abc"));
    expect(hashApiKey("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints high-entropy keys with the tsp_ prefix", () => {
    const key = newApiKey();
    expect(key).toMatch(/^tsp_[A-Za-z0-9_-]{43}$/);
    expect(newApiKey()).not.toBe(key);
  });

  it("accepts a stored, unrevoked key", async () => {
    const key = newApiKey();
    const auth = createAuthenticator({
      store: storeOf([{ hash: hashApiKey(key), revokedAt: null }]),
      bootstrapApiKey: undefined,
    });
    await expect(auth.verify(key)).resolves.toBe(true);
    await expect(auth.verify(`${key}x`)).resolves.toBe(false);
    await expect(auth.verify("")).resolves.toBe(false);
  });

  it("rejects a revoked key (revoked_at respected)", async () => {
    const key = newApiKey();
    const auth = createAuthenticator({
      store: storeOf([{ hash: hashApiKey(key), revokedAt: new Date() }]),
      bootstrapApiKey: undefined,
    });
    await expect(auth.verify(key)).resolves.toBe(false);
  });

  it("accepts the bootstrap key without a store", async () => {
    const auth = createAuthenticator({ store: null, bootstrapApiKey: "dev-key" });
    await expect(auth.verify("dev-key")).resolves.toBe(true);
    await expect(auth.verify("other")).resolves.toBe(false);
  });

  it("rejects everything when neither store nor bootstrap key exists", async () => {
    const auth = createAuthenticator({ store: null, bootstrapApiKey: undefined });
    await expect(auth.verify("anything")).resolves.toBe(false);
  });

  it("parses Authorization: Bearer", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("Basic abc123")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});
