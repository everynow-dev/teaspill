import { describe, expect, it } from "vitest";
import { decodeJwt, errors, jwtVerify } from "jose";
import { mintReadToken } from "./read-token.js";

const SECRET = "test-shared-secret-for-read-tokens";
const key = new TextEncoder().encode(SECRET);

describe("mintReadToken", () => {
  it("mints a compact HS256 JWT that verifies with the shared secret (round-trip)", async () => {
    const pfx = "/streams/t/default/agents/researcher/x1/";
    const jwt = await mintReadToken({ pfx, ttlSeconds: 300, secret: SECRET });

    // Compact JWS shape: header.payload.signature
    expect(jwt.split(".")).toHaveLength(3);

    const { payload, protectedHeader } = await jwtVerify(jwt, key, { algorithms: ["HS256"] });
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.pfx).toBe(pfx);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it("produces a token that fails verification under a different secret", async () => {
    const jwt = await mintReadToken({ pfx: "/streams/x/", ttlSeconds: 60, secret: SECRET });
    await expect(
      jwtVerify(jwt, new TextEncoder().encode("wrong-secret"), { algorithms: ["HS256"] }),
    ).rejects.toBeInstanceOf(errors.JWSSignatureVerificationFailed);
  });

  it("mints an already-expired token that jose rejects with no leeway", async () => {
    // ttl of 1s, then verify with negative tolerance to force expiry.
    const jwt = await mintReadToken({ pfx: "/shapes/v1/shape/", ttlSeconds: 1, secret: SECRET });
    const decoded = decodeJwt(jwt);
    // Sanity: exp is 1s after iat.
    expect(decoded.exp! - decoded.iat!).toBe(1);
    await expect(
      jwtVerify(jwt, key, { algorithms: ["HS256"], currentDate: new Date(Date.now() + 5000) }),
    ).rejects.toBeInstanceOf(errors.JWTExpired);
  });

  it("accepts a /shapes/ prefix", async () => {
    const jwt = await mintReadToken({ pfx: "/shapes/v1/shape/", ttlSeconds: 60, secret: SECRET });
    expect(decodeJwt(jwt).pfx).toBe("/shapes/v1/shape/");
  });

  it("rejects a prefix not rooted at /streams/ or /shapes/", async () => {
    await expect(
      mintReadToken({ pfx: "/api/spawn", ttlSeconds: 60, secret: SECRET }),
    ).rejects.toThrow(/must start with/);
    await expect(
      mintReadToken({ pfx: "/streams", ttlSeconds: 60, secret: SECRET }),
    ).rejects.toThrow(/must start with/);
  });

  it("rejects a non-positive or non-integer ttl", async () => {
    await expect(
      mintReadToken({ pfx: "/streams/x/", ttlSeconds: 0, secret: SECRET }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      mintReadToken({ pfx: "/streams/x/", ttlSeconds: 1.5, secret: SECRET }),
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects an empty secret", async () => {
    await expect(
      mintReadToken({ pfx: "/streams/x/", ttlSeconds: 60, secret: "" }),
    ).rejects.toThrow(/non-empty/);
  });
});
