/**
 * 0001:T1.4 — the optional JWT read path + CORS, exercised through the gateway.
 *
 * Asserts the auth composition rules from app.ts:
 *  - a valid read token (matching pfx) authorizes GET /streams and /shapes;
 *  - wrong pfx → 403; expired-beyond-leeway → 401; within-leeway → 200;
 *  - a read token is NEVER honoured on /api/* or on a non-GET method;
 *  - the API-key path is unchanged (still works on the same routes);
 *  - CORS preflight (OPTIONS) is answered without a token;
 *  - CORS response headers ride GET reads (including 401s) so a browser can
 *    read the status and reconnect with a fresh token.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import {
  authHeader,
  fakeUpstream,
  testConfig,
  testGateway,
  type FakeUpstream,
} from "./testing/test-support.js";

const JWT_SECRET = "read-path-integration-secret";

const ENTITY_PFX = "/streams/t/default/agents/researcher/x1/";
const TIMELINE = "/streams/t/default/agents/researcher/x1/timeline";
const DELTAS = "/streams/t/default/agents/researcher/x1/deltas";
const ORIGIN = "https://app.example.com";

async function mint(
  pfx: string,
  opts: { expOffsetSec?: number; secret?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ pfx })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expOffsetSec ?? 300))
    .sign(new TextEncoder().encode(opts.secret ?? JWT_SECRET));
}

function jwtHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("JWT read path — /streams", () => {
  let streams: FakeUpstream;
  let app: FastifyInstance;

  beforeEach(async () => {
    streams = await fakeUpstream({
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: '"t-1"',
        "stream-next-offset": "0000000000000042_0000000000000000",
      },
      body: JSON.stringify([{ seq: 0 }]),
    });
    app = testGateway(testConfig({ durableStreamsUrl: streams.url, jwtSecret: JWT_SECRET }));
  });
  afterEach(async () => {
    await app.close();
    await streams.close();
  });

  it("authorizes a GET with a matching-pfx read token", async () => {
    const token = await mint(ENTITY_PFX);
    const res = await app.inject({ method: "GET", url: TIMELINE, headers: jwtHeader(token) });
    expect(res.statusCode).toBe(200);
    expect(streams.requests).toHaveLength(1);
    // The token never leaks to the internal service.
    expect(streams.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("one entity-prefix token covers both /timeline and /deltas (casdk-mapping §8.5)", async () => {
    const token = await mint(ENTITY_PFX);
    const t = await app.inject({ method: "GET", url: TIMELINE, headers: jwtHeader(token) });
    const d = await app.inject({ method: "GET", url: DELTAS, headers: jwtHeader(token) });
    expect(t.statusCode).toBe(200);
    expect(d.statusCode).toBe(200);
  });

  it("rejects a token whose pfx does not cover the path (403)", async () => {
    const token = await mint("/streams/t/default/agents/researcher/other/");
    const res = await app.inject({ method: "GET", url: TIMELINE, headers: jwtHeader(token) });
    expect(res.statusCode).toBe(403);
    expect(streams.requests).toHaveLength(0);
  });

  it("guards the prefix boundary: /x1/ does not match a sibling /x1extra/", async () => {
    const token = await mint(ENTITY_PFX);
    const res = await app.inject({
      method: "GET",
      url: "/streams/t/default/agents/researcher/x1extra/timeline",
      headers: jwtHeader(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an expired-beyond-leeway token (401, reconnect hint)", async () => {
    const token = await mint(ENTITY_PFX, { expOffsetSec: -120 });
    const res = await app.inject({ method: "GET", url: TIMELINE, headers: jwtHeader(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/expired/);
    expect(res.json().error).toMatch(/reconnect/);
    expect(streams.requests).toHaveLength(0);
  });

  it("accepts a token expired only within the clock-skew leeway", async () => {
    const token = await mint(ENTITY_PFX, { expOffsetSec: -30 }); // < 60s default leeway
    const res = await app.inject({ method: "GET", url: TIMELINE, headers: jwtHeader(token) });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a token signed with the wrong secret (401)", async () => {
    const token = await mint(ENTITY_PFX, { secret: "not-the-secret" });
    const res = await app.inject({ method: "GET", url: TIMELINE, headers: jwtHeader(token) });
    expect(res.statusCode).toBe(401);
    expect(streams.requests).toHaveLength(0);
  });

  it("never honours a read token on a non-GET method (writes never bypass)", async () => {
    const token = await mint(ENTITY_PFX);
    const res = await app.inject({ method: "POST", url: TIMELINE, headers: jwtHeader(token) });
    expect(res.statusCode).toBe(401);
    expect(streams.requests).toHaveLength(0);
  });

  it("still accepts a plain API key on the same GET route (path unchanged)", async () => {
    const res = await app.inject({ method: "GET", url: TIMELINE, headers: authHeader });
    expect(res.statusCode).toBe(200);
    expect(streams.requests).toHaveLength(1);
  });

  it("rejects a GET with no credentials at all (401)", async () => {
    const res = await app.inject({ method: "GET", url: TIMELINE });
    expect(res.statusCode).toBe(401);
    expect(streams.requests).toHaveLength(0);
  });
});

describe("JWT read path — /shapes", () => {
  let electric: FakeUpstream;
  let app: FastifyInstance;

  beforeEach(async () => {
    electric = await fakeUpstream({
      status: 200,
      headers: { "content-type": "application/json", "electric-offset": "0_1" },
      body: "[]",
    });
    app = testGateway(testConfig({ electricUrl: electric.url, jwtSecret: JWT_SECRET }));
  });
  afterEach(async () => {
    await app.close();
    await electric.close();
  });

  it("authorizes a GET /shapes with a matching-pfx token", async () => {
    const token = await mint("/shapes/v1/shape/");
    const res = await app.inject({
      method: "GET",
      url: "/shapes/v1/shape/?table=entities",
      headers: jwtHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(electric.requests).toHaveLength(1);
  });
});

describe("JWT read path — never on writes (/api)", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = testGateway(testConfig({ jwtSecret: JWT_SECRET }));
  });
  afterEach(async () => {
    await app.close();
  });

  it("a read token on /api/* is not honoured (401, treated as a bad API key)", async () => {
    // Even a token whose pfx names /api cannot authorize a write route.
    const token = await mint("/streams/t/default/agents/researcher/x1/");
    const res = await app.inject({
      method: "POST",
      url: "/api/a/researcher/x1/send",
      headers: { ...jwtHeader(token), "content-type": "application/json" },
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("JWT read path disabled when no secret is configured", () => {
  let streams: FakeUpstream;
  let app: FastifyInstance;
  beforeEach(async () => {
    streams = await fakeUpstream({ status: 200, body: "[]" });
    // jwtSecret undefined (testConfig default)
    app = testGateway(testConfig({ durableStreamsUrl: streams.url }));
  });
  afterEach(async () => {
    await app.close();
    await streams.close();
  });

  it("rejects an otherwise-valid read token (401) — API keys only", async () => {
    const token = await mint(ENTITY_PFX);
    const res = await app.inject({ method: "GET", url: TIMELINE, headers: jwtHeader(token) });
    expect(res.statusCode).toBe(401);
    expect(streams.requests).toHaveLength(0);
  });
});

describe("CORS for the browser read routes", () => {
  let streams: FakeUpstream;
  let app: FastifyInstance;

  beforeEach(async () => {
    streams = await fakeUpstream({
      status: 200,
      headers: { "content-type": "application/json", etag: '"t-1"' },
      body: "[]",
    });
    app = testGateway(testConfig({ durableStreamsUrl: streams.url, jwtSecret: JWT_SECRET }));
  });
  afterEach(async () => {
    await app.close();
    await streams.close();
  });

  it("answers an OPTIONS preflight without a token (204 + CORS headers)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: TIMELINE,
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,if-none-match",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
    expect(res.headers["access-control-allow-headers"]).toContain("authorization");
    expect(streams.requests).toHaveLength(0);
  });

  it("puts CORS headers on a successful cross-origin GET read", async () => {
    const token = await mint(ENTITY_PFX);
    const res = await app.inject({
      method: "GET",
      url: TIMELINE,
      headers: { ...jwtHeader(token), origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-expose-headers"]).toBe("*");
  });

  it("puts CORS headers on a 401 too, so the browser can see it and reconnect", async () => {
    const token = await mint(ENTITY_PFX, { expOffsetSec: -120 });
    const res = await app.inject({
      method: "GET",
      url: TIMELINE,
      headers: { ...jwtHeader(token), origin: ORIGIN },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("reflects only allow-listed origins when a list is configured", async () => {
    await app.close();
    app = testGateway(
      testConfig({
        durableStreamsUrl: streams.url,
        jwtSecret: JWT_SECRET,
        corsAllowOrigins: [ORIGIN],
      }),
    );
    const token = await mint(ENTITY_PFX);

    const allowed = await app.inject({
      method: "GET",
      url: TIMELINE,
      headers: { ...jwtHeader(token), origin: ORIGIN },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(allowed.headers.vary).toContain("Origin");

    const denied = await app.inject({
      method: "GET",
      url: TIMELINE,
      headers: { ...jwtHeader(token), origin: "https://evil.example.com" },
    });
    // Request still authorized (server-side), but no CORS grant for this origin.
    expect(denied.statusCode).toBe(200);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
