import { describe, expect, it, vi } from "vitest";
import { GatewayActionError, createActionsClient, entityApiPath } from "./actions.js";

const ACCEPTED = {
  url: "/t/default/a/researcher/01x",
  streamPath: "/t/default/agents/researcher/01x/timeline",
  streamUrl: "/streams/t/default/agents/researcher/01x/timeline",
  restate: { invocationId: "inv-1" },
};

function fetchMock(status = 202, body: unknown = ACCEPTED) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("entityApiPath", () => {
  it("accepts { type, id }", () => {
    expect(entityApiPath({ type: "researcher", id: "01x" })).toBe("/api/a/researcher/01x");
  });
  it("accepts the gateway short form", () => {
    expect(entityApiPath("/a/researcher/01x")).toBe("/api/a/researcher/01x");
  });
  it("accepts a canonical url (tenant-qualified route)", () => {
    expect(entityApiPath("/t/default/a/researcher/01x")).toBe("/api/t/default/a/researcher/01x");
  });
  it("rejects malformed targets", () => {
    expect(() => entityApiPath("researcher/01x")).toThrow(/not an entity target/);
    expect(() => entityApiPath({ type: "Bad Type", id: "01x" })).toThrow(/invalid entity type/);
  });
});

describe("createActionsClient", () => {
  it("spawn posts to /api/spawn with auth + idempotency key", async () => {
    const doFetch = fetchMock();
    const client = createActionsClient({
      baseUrl: "http://gw.test/",
      auth: { apiKey: "tsp_secret" },
      fetch: doFetch as unknown as typeof fetch,
    });
    const res = await client.spawn(
      { type: "researcher", args: { topic: "tea" }, parent: "/t/default/a/root/01p" },
      { idempotencyKey: "spawn-1" },
    );
    expect(res).toEqual(ACCEPTED);
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gw.test/api/spawn");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tsp_secret");
    expect(headers["idempotency-key"]).toBe("spawn-1");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "researcher",
      args: { topic: "tea" },
      parent: "/t/default/a/root/01p",
    });
  });

  it("send posts the message body verbatim to the entity route", async () => {
    const doFetch = fetchMock();
    const client = createActionsClient({
      baseUrl: "http://gw.test",
      fetch: doFetch as unknown as typeof fetch,
    });
    await client.send({ type: "researcher", id: "01x" }, { text: "hello" });
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gw.test/api/a/researcher/01x/send");
    expect(JSON.parse(String(init.body))).toEqual({ text: "hello" });
  });

  it("control verbs post { verb, reason? }", async () => {
    const doFetch = fetchMock();
    const client = createActionsClient({
      baseUrl: "http://gw.test",
      fetch: doFetch as unknown as typeof fetch,
    });
    await client.interrupt("/a/researcher/01x", "user clicked stop");
    await client.archive("/a/researcher/01x");
    const [url1, init1] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url1).toBe("http://gw.test/api/a/researcher/01x/control");
    expect(JSON.parse(String(init1.body))).toEqual({
      verb: "interrupt",
      reason: "user clicked stop",
    });
    const [, init2] = doFetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init2.body))).toEqual({ verb: "archive" });
  });

  it("non-2xx responses throw GatewayActionError with the gateway's message", async () => {
    const doFetch = fetchMock(400, { error: 'invalid "verb"' });
    const client = createActionsClient({
      baseUrl: "http://gw.test",
      fetch: doFetch as unknown as typeof fetch,
    });
    await expect(client.send({ type: "researcher", id: "01x" }, {})).rejects.toMatchObject({
      name: "GatewayActionError",
      status: 400,
      message: 'invalid "verb"',
    });
    await expect(client.send({ type: "researcher", id: "01x" }, {})).rejects.toBeInstanceOf(
      GatewayActionError,
    );
  });
});
