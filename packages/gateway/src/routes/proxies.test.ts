import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  authHeader,
  fakeUpstream,
  testConfig,
  testGateway,
  type FakeUpstream,
} from "../testing/test-support.js";

describe("/shapes/* → Electric proxy", () => {
  let electric: FakeUpstream;
  let app: FastifyInstance;

  beforeEach(async () => {
    electric = await fakeUpstream({
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: '"shape-etag-1"',
        "electric-handle": "h-123",
        "electric-offset": "0_42",
        "cache-control": "public, max-age=60",
      },
      body: JSON.stringify([{ key: "row1" }]),
    });
    app = testGateway(testConfig({ electricUrl: electric.url }));
  });

  afterEach(async () => {
    await app.close();
    await electric.close();
  });

  it("preserves path, query params (byte-exact), and conditional headers", async () => {
    const query = "table=entities&offset=-1&where=type%3D%241&params%5B1%5D=researcher";
    const res = await app.inject({
      method: "GET",
      url: `/shapes/v1/shape?${query}`,
      headers: { ...authHeader, "if-none-match": '"prior-etag"' },
    });
    expect(res.statusCode).toBe(200);

    const upstream = electric.requests[0]!;
    expect(upstream.url).toBe(`/v1/shape?${query}`); // untouched, incl. percent-encoding
    expect(upstream.headers["if-none-match"]).toBe('"prior-etag"');
    // The gateway API key never reaches internal services.
    expect(upstream.headers.authorization).toBeUndefined();

    // Electric's shape/cache headers come back verbatim.
    expect(res.headers.etag).toBe('"shape-etag-1"');
    expect(res.headers["electric-handle"]).toBe("h-123");
    expect(res.headers["electric-offset"]).toBe("0_42");
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.body).toBe(JSON.stringify([{ key: "row1" }]));
  });

  it("404s on a bare /shapes with no upstream path", async () => {
    const res = await app.inject({ method: "GET", url: "/shapes/", headers: authHeader });
    expect(res.statusCode).toBe(404);
    expect(electric.requests).toHaveLength(0);
  });
});

describe("/registry/* → Restate admin API (deployment registration)", () => {
  let admin: FakeUpstream;
  let app: FastifyInstance;

  beforeEach(async () => {
    admin = await fakeUpstream({
      status: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "dp_1", services: [{ name: "agent.researcher" }] }),
    });
    app = testGateway(testConfig({ restateAdminUrl: admin.url }));
  });

  afterEach(async () => {
    await app.close();
    await admin.close();
  });

  it("forwards POST /registry/deployments with the service URL as-is (no rewriting)", async () => {
    // The registered uri uses host.docker.internal per
    // docs/self-hosting-networking.md §3(b) — the gateway must forward it
    // VERBATIM (never rewrite; that was electric agents' loopback bug class).
    const payload = { uri: "http://host.docker.internal:9080", force: false };
    const res = await app.inject({
      method: "POST",
      url: "/registry/deployments",
      headers: { ...authHeader, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: "dp_1", services: [{ name: "agent.researcher" }] });

    const upstream = admin.requests[0]!;
    expect(upstream.method).toBe("POST");
    expect(upstream.url).toBe("/deployments");
    expect(JSON.parse(upstream.body)).toEqual(payload); // uri untouched
    expect(upstream.headers.authorization).toBeUndefined();
  });

  it("forwards deployment inspection and service discovery reads", async () => {
    const byId = await app.inject({
      method: "GET",
      url: "/registry/deployments/dp_1",
      headers: authHeader,
    });
    expect(byId.statusCode).toBe(201); // fake echoes one canned status
    expect(admin.requests[0]!.url).toBe("/deployments/dp_1");

    const services = await app.inject({
      method: "GET",
      url: "/registry/services/agent.researcher",
      headers: authHeader,
    });
    expect(services.statusCode).toBe(201);
    expect(admin.requests[1]!.url).toBe("/services/agent.researcher");
  });

  it("refuses admin endpoints outside the allowlist (0001:D6: minimal surface)", async () => {
    for (const [method, url] of [
      ["POST", "/registry/services/agent.researcher"], // services are read-only
      ["GET", "/registry/invocations"],
      ["POST", "/registry/cluster/config"],
    ] as const) {
      const res = await app.inject({ method, url, headers: authHeader });
      expect([404, 405]).toContain(res.statusCode);
    }
    expect(admin.requests).toHaveLength(0);
  });
});
