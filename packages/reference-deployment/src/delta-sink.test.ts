/**
 * Per-entity delta emitter (0002:T4.2 — the concrete `emitDeltaFactory`
 * consumer closing 0002:T4.1's "emitDelta entityId gap"): stamps v1+entityId,
 * lazily PUT-creates the `/deltas` stream with a TTL, appends fire-and-forget,
 * and NEVER throws (createSafeDeltaEmitter invariants).
 */

import { describe, expect, it, vi } from "vitest";
import type { DeltaInit } from "@teaspill/schema";
import { deltasStreamPath } from "@teaspill/schema";
import { createDeltaEmitterFactory } from "./delta-sink.js";

const ENTITY = "/t/default/a/demo-pi/e-1";

const delta = (text: string): DeltaInit => ({
  kind: "text",
  runId: "r1",
  ref: "m1",
  idx: 0,
  ts: "2026-07-18T00:00:00.000Z",
  text,
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(calls: Call[], failWith?: number): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    });
    if (failWith !== undefined) return new Response("nope", { status: failWith });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

describe("createDeltaEmitterFactory", () => {
  it("PUT-creates the entity's /deltas stream with a TTL once, then appends stamped records", async () => {
    const calls: Call[] = [];
    const emit = createDeltaEmitterFactory({
      streamsUrl: "http://durable-streams:4437",
      ttlSeconds: 21600,
      fetch: fakeFetch(calls),
    })({ entityId: ENTITY });

    emit(delta("a"));
    await vi.waitFor(() => expect(calls.length).toBe(2));
    emit(delta("b"));
    await vi.waitFor(() => expect(calls.length).toBe(3));

    const path = deltasStreamPath(ENTITY);
    expect(calls[0]).toMatchObject({
      url: `http://durable-streams:4437${path}`,
      method: "PUT",
      headers: { "stream-ttl": "21600" },
    });
    // Appends stamp v1 + entityId — the exact context the config-level
    // emitter seam could not supply (the 0002:T4.1 flag).
    expect(calls[1]).toMatchObject({ method: "POST", url: `http://durable-streams:4437${path}` });
    expect(calls[1]!.body).toEqual([{ ...delta("a"), v: 1, entityId: ENTITY }]);
    expect(calls[2]!.body).toEqual([{ ...delta("b"), v: 1, entityId: ENTITY }]);
    // ensure memoized: only ONE PUT across both emits.
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("never throws and reports drops on server errors (best-effort invariant)", async () => {
    const calls: Call[] = [];
    const dropped: unknown[] = [];
    const emit = createDeltaEmitterFactory({
      streamsUrl: "http://durable-streams:4437",
      fetch: fakeFetch(calls, 503),
      onDrop: (err) => dropped.push(err),
    })({ entityId: ENTITY });

    expect(() => emit(delta("x"))).not.toThrow();
    await vi.waitFor(() => expect(dropped.length).toBeGreaterThan(0));
  });
});
