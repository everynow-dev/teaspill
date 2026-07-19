import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  authHeader,
  fakeUpstream,
  testConfig,
  testGateway,
  type FakeUpstream,
} from "../testing/test-support.js";

describe("/api/* command endpoints → Restate ingress", () => {
  let ingress: FakeUpstream;
  let app: FastifyInstance;

  beforeEach(async () => {
    ingress = await fakeUpstream({
      status: 202,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invocationId: "inv_1", status: "Accepted" }),
    });
    app = testGateway(testConfig({ restateIngressUrl: ingress.url }));
  });

  afterEach(async () => {
    await app.close();
    await ingress.close();
  });

  it("spawn: generates a ULID id and sends agent.<type>/<id>/spawn/send", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/spawn",
      headers: authHeader,
      payload: { type: "researcher", args: { goal: "dig" } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { url: string; streamPath: string; streamUrl: string };
    expect(body.url).toMatch(/^\/t\/default\/a\/researcher\/[a-z0-9]{26}$/);
    expect(body.streamPath).toBe(
      `/t/default/agents/researcher/${body.url.split("/").at(-1)}/timeline`,
    );
    expect(body.streamUrl).toBe(`/streams${body.streamPath}`);

    expect(ingress.requests).toHaveLength(1);
    const req = ingress.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toMatch(/^\/agent\.researcher\/[a-z0-9]{26}\/spawn\/send$/);
    expect(JSON.parse(req.body)).toEqual({ args: { goal: "dig" }, parentRef: null });
  });

  it("spawn: accepts a caller-supplied id (deterministic spawn)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/spawn",
      headers: authHeader,
      payload: { type: "researcher", id: "my-agent_1", parent: "/t/default/a/lead/l1" },
    });
    expect(res.statusCode).toBe(202);
    expect(ingress.requests[0]!.url).toBe("/agent.researcher/my-agent_1/spawn/send");
    // NO `args` key: an argless spawn must not forward `args: null` — that
    // satisfied handleSpawn's `!== undefined` check and rendered a junk
    // `"null"` user message on every argless spawn (0002:T4.2 live finding).
    expect(JSON.parse(ingress.requests[0]!.body)).toEqual({
      parentRef: "/t/default/a/lead/l1",
    });
  });

  it("spawn: forwards a spawn-chosen workspaceRef (0001:D4, additive 0002:T4.2)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/spawn",
      headers: authHeader,
      payload: { type: "researcher", id: "w-agent", workspaceRef: "default/shared-ws" },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(ingress.requests[0]!.body)).toEqual({
      parentRef: null,
      workspaceRef: "default/shared-ws",
    });
  });

  it("spawn: rejects a non-string workspaceRef", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/spawn",
      headers: authHeader,
      payload: { type: "researcher", workspaceRef: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(ingress.requests).toHaveLength(0);
  });

  it("spawn: rejects an empty id — 0001:A3, no empty Restate keys", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/spawn",
      headers: authHeader,
      payload: { type: "researcher", id: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(ingress.requests).toHaveLength(0);
  });

  it("spawn: rejects invalid types", async () => {
    for (const type of ["Bad.Type", "UPPER", "", undefined]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/spawn",
        headers: authHeader,
        payload: { type },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(ingress.requests).toHaveLength(0);
  });

  it("send: wakes agent.<type>/<id>/message with the message as payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/a/researcher/r1/send",
      headers: authHeader,
      payload: { role: "user", text: "hello" },
    });
    expect(res.statusCode).toBe(202);
    const req = ingress.requests[0]!;
    expect(req.url).toBe("/agent.researcher/r1/message/send");
    expect(JSON.parse(req.body)).toEqual({ role: "user", text: "hello" });
  });

  it("send: accepts the canonical tenant-qualified form for the deployment tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/t/default/a/researcher/r1/send",
      headers: authHeader,
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(202);
  });

  it("send: rejects a foreign tenant (single-tenant deployment, 0001:D8)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/t/other/a/researcher/r1/send",
      headers: authHeader,
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("tenant");
  });

  it("control: validates the 0001:T2.5 verb set and dispatches to the PER-VERB handler", async () => {
    // 0002:T4.2 regression: the route used to forward every verb to a single
    // `control` handler NO agent object has (interrupt is SHARED,
    // pause/resume/archive EXCLUSIVE — 0001:A8) — every live control verb
    // 404'd at Restate ingress while this suite's fake ingress accepted it.
    const ok = await app.inject({
      method: "POST",
      url: "/api/a/researcher/r1/control",
      headers: authHeader,
      payload: { verb: "interrupt", reason: "user asked" },
    });
    expect(ok.statusCode).toBe(202);
    expect(ingress.requests[0]!.url).toBe("/agent.researcher/r1/interrupt/send");
    expect(JSON.parse(ingress.requests[0]!.body)).toEqual({ reason: "user asked" });

    for (const verb of ["pause", "resume", "archive"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/a/researcher/r1/control",
        headers: authHeader,
        payload: { verb },
      });
      expect(res.statusCode).toBe(202);
      const req = ingress.requests.at(-1)!;
      expect(req.url).toBe(`/agent.researcher/r1/${verb}/send`);
      expect(JSON.parse(req.body)).toEqual({}); // ControlInput: no verb field, reason only when given
    }

    const bad = await app.inject({
      method: "POST",
      url: "/api/a/researcher/r1/control",
      headers: authHeader,
      payload: { verb: "SIGKILL" }, // POSIX cosplay is exactly what 0001:D8 dropped
    });
    expect(bad.statusCode).toBe(400);
  });

  it("forwards a client Idempotency-Key to ingress (SPIKE (c): retry shielding)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/a/researcher/r1/send",
      headers: { ...authHeader, "idempotency-key": "client-retry-1" },
      payload: { text: "hi" },
    });
    expect(ingress.requests[0]!.headers["idempotency-key"]).toBe("client-retry-1");
  });

  it("enforces the 1 MiB body limit with a clear error (T1.2c)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/a/researcher/r1/send",
      headers: { ...authHeader, "content-type": "application/json" },
      payload: JSON.stringify({ blob: "x".repeat(1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    const err = (res.json() as { error: string }).error;
    expect(err).toContain("1048576");
    expect(err).toContain("attachments");
    expect(ingress.requests).toHaveLength(0);
  });

  it("maps an unreachable ingress to 502, not a hang or a 500", async () => {
    const dead = testGateway(testConfig({ restateIngressUrl: "http://127.0.0.1:1" }));
    const res = await dead.inject({
      method: "POST",
      url: "/api/a/researcher/r1/send",
      headers: authHeader,
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(502);
    await dead.close();
  });
});

describe("auth middleware (0001:D6)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = testGateway(testConfig());
  });
  afterEach(async () => {
    await app.close();
  });

  it("GET /health is public (compose healthcheck)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects missing and invalid API keys with 401 on every other route", async () => {
    for (const url of [
      "/api/spawn",
      "/streams/t/default/x",
      "/shapes/v1/shape",
      "/registry/deployments",
    ]) {
      const missing = await app.inject({ method: "GET", url });
      expect(missing.statusCode).toBe(401);
      const invalid = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer wrong-key" },
      });
      expect(invalid.statusCode).toBe(401);
    }
  });
});
