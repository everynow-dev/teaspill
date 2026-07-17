import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { createReadTokenVerifier, looksLikeJwt } from "./jwt.js";

const SECRET = "gateway-read-token-secret";
const key = new TextEncoder().encode(SECRET);

async function mint(
  claims: Record<string, unknown>,
  opts: { expOffsetSec?: number; alg?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expOffsetSec ?? 300))
    .sign(key);
}

describe("looksLikeJwt", () => {
  it("recognises three-segment compact JWS and rejects API keys", () => {
    expect(looksLikeJwt("aaa.bbb.ccc")).toBe(true);
    expect(looksLikeJwt("tsp_abcDEF-123_xyz")).toBe(false); // API key: no dots
    expect(looksLikeJwt("aaa.bbb")).toBe(false); // two segments
    expect(looksLikeJwt("aaa.bbb.ccc.ddd")).toBe(false); // four segments
    expect(looksLikeJwt("aaa.bb b.ccc")).toBe(false); // whitespace
  });
});

describe("createReadTokenVerifier", () => {
  const verifier = createReadTokenVerifier({ secret: SECRET, clockToleranceSeconds: 60 });

  it("accepts a valid HS256 token and returns its pfx", async () => {
    const jwt = await mint({ pfx: "/streams/x/" });
    await expect(verifier.verify(jwt)).resolves.toEqual({ ok: true, pfx: "/streams/x/" });
  });

  it("reports expiry beyond the leeway as reason=expired", async () => {
    const jwt = await mint({ pfx: "/streams/x/" }, { expOffsetSec: -120 });
    await expect(verifier.verify(jwt)).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token expired only WITHIN the clock-skew leeway", async () => {
    const jwt = await mint({ pfx: "/streams/x/" }, { expOffsetSec: -30 }); // 30s < 60s leeway
    await expect(verifier.verify(jwt)).resolves.toEqual({ ok: true, pfx: "/streams/x/" });
  });

  it("rejects a bad signature (wrong secret) as reason=invalid", async () => {
    const other = new SignJWT({ pfx: "/streams/x/" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m");
    const jwt = await other.sign(new TextEncoder().encode("some-other-secret"));
    await expect(verifier.verify(jwt)).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token with no/blank pfx claim as reason=invalid", async () => {
    await expect(verifier.verify(await mint({}))).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(verifier.verify(await mint({ pfx: "" }))).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses a non-HS256 (alg confusion) token", async () => {
    // A valid HMAC token under a non-allow-listed alg must be refused.
    const jwt = await new SignJWT({ pfx: "/streams/x/" })
      .setProtectedHeader({ alg: "HS384" }) // valid HMAC alg, but not allow-listed
      .setExpirationTime("5m")
      .sign(key);
    await expect(verifier.verify(jwt)).resolves.toEqual({ ok: false, reason: "invalid" });
  });
});
