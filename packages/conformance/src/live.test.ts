/**
 * Offline regression tests for the live driver's transport seams — every one
 * of these encodes a bug the FIRST live conformance run (0002:T4.2) actually
 * hit, at the lowest layer that can express it (a fake durable-streams fetch;
 * no stack needed):
 *
 *   1. Relative `streamUrl` resolution: the gateway returns RELATIVE stream
 *      urls (`/streams/…`) — fine in a browser, fatal in Node where
 *      `stream({ url })` has no base. The driver must resolve against
 *      `config.baseUrl`.
 *   2. Silent transport failure: a fatal read error (bad url, 401…) used to
 *      masquerade as a predicate timeout over 0 events. It must reject loudly.
 *   3. Not-yet-created stream: a spawn is ACCEPTED (202) before the first
 *      outbox flush PUT-creates the timeline stream, so an immediate read can
 *      404 — the driver retries until the deadline instead of failing fast.
 */

import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@teaspill/schema";
import {
  createLiveDriver,
  isStreamNotFound,
  liveTestTimeout,
  LIVE_TEST_TIMEOUT_MARGIN_MS,
  readStackConfig,
  resolveStreamUrl,
  type StackConfig,
} from "./live.js";

const BASE_URL = "http://stack.test:8787";
const RELATIVE_STREAM = "/streams/t/default/agents/conformance-echo/01unit/timeline";

function events(): TimelineEvent[] {
  const entityId = "/t/default/a/conformance-echo/01unit";
  const ts = "2026-07-18T00:00:00.000Z";
  return [
    { v: 1, entityId, seq: 0, ts, type: "entity_spawned", payload: { entityType: "conformance-echo", parentId: null } },
    { v: 1, entityId, seq: 1, ts, type: "run_started", payload: { runId: "r1", wake: { source: "message" }, harness: "native" } },
    { v: 1, entityId, seq: 2, ts, type: "message", payload: { id: "m1", runId: "r1", role: "assistant", content: [{ type: "text", text: "pong" }] } },
    { v: 1, entityId, seq: 3, ts, type: "run_finished", payload: { runId: "r1", outcome: "success", usage: { inputTokens: 0, outputTokens: 0 } } },
  ];
}

/**
 * Minimal durable-streams read fake (same protocol shape as frontend-sdk's
 * timeline.test.ts): one batch, then up-to-date + closed. `missingReads`
 * makes the first N reads 404 (the not-yet-created window); `status` forces
 * a fixed error status instead.
 */
function fakeStreamFetch(opts: {
  batch: unknown[];
  seenUrls?: string[];
  missingReads?: number;
  status?: number;
}): typeof fetch {
  let reads = 0;
  return (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    opts.seenUrls?.push(req.url);
    if (opts.status !== undefined) {
      return Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: opts.status }));
    }
    reads += 1;
    if (opts.missingReads !== undefined && reads <= opts.missingReads) {
      return Promise.resolve(new Response(JSON.stringify({ error: "stream not found" }), { status: 404 }));
    }
    const u = new URL(req.url);
    const offsetParam = u.searchParams.get("offset") ?? "-1";
    const atEnd = offsetParam !== "-1";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "stream-next-offset": "1",
      "stream-up-to-date": "true",
      "stream-closed": "true",
    };
    if (atEnd) return Promise.resolve(new Response(null, { status: 204, headers }));
    return Promise.resolve(new Response(JSON.stringify(opts.batch), { status: 200, headers }));
  };
}

function stackWith(fetchImpl: typeof fetch): StackConfig {
  const stack = readStackConfig({ TEASPILL_STACK_URL: BASE_URL });
  if (stack === null) throw new Error("unreachable");
  return { ...stack, timeoutMs: 5_000, fetch: fetchImpl };
}

describe("resolveStreamUrl", () => {
  it("resolves the gateway's RELATIVE stream urls against the stack base url", () => {
    expect(resolveStreamUrl(RELATIVE_STREAM, BASE_URL)).toBe(BASE_URL + RELATIVE_STREAM);
  });
  it("passes absolute urls through untouched", () => {
    const absolute = "http://elsewhere.test/streams/x/timeline";
    expect(resolveStreamUrl(absolute, BASE_URL)).toBe(absolute);
  });
});

describe("observeUntil transport seams (through a fake wire)", () => {
  it("observes a RELATIVE streamUrl by resolving it against baseUrl", async () => {
    const seenUrls: string[] = [];
    const driver = createLiveDriver(stackWith(fakeStreamFetch({ batch: events(), seenUrls })));
    const observed = await driver.observeUntil(RELATIVE_STREAM, (evs) =>
      evs.some((e) => e.type === "run_finished"),
    );
    expect(observed.map((e) => e.seq)).toContain(3);
    expect(seenUrls.length).toBeGreaterThan(0);
    for (const url of seenUrls) expect(url.startsWith(BASE_URL + RELATIVE_STREAM)).toBe(true);
  });

  it("rejects LOUDLY on a fatal transport error instead of timing out silently", async () => {
    const driver = createLiveDriver(stackWith(fakeStreamFetch({ batch: [], status: 401 })));
    await expect(
      driver.observeUntil(RELATIVE_STREAM, () => false, { timeoutMs: 3_000 }),
    ).rejects.toThrow(/timeline read failed/);
  });

  it("retries through the not-yet-created 404 window (spawn accepted before first flush)", async () => {
    const driver = createLiveDriver(
      stackWith(fakeStreamFetch({ batch: events(), missingReads: 2 })),
    );
    const observed = await driver.observeUntil(RELATIVE_STREAM, (evs) =>
      evs.some((e) => e.type === "run_finished"),
    );
    // Raw events via onEvents: the COMPLETE sequence, including run_started.
    expect(observed.map((e) => e.seq)).toStrictEqual([0, 1, 2, 3]);
  });

  it("a stream that NEVER appears still times out at the deadline (bounded retry)", async () => {
    const driver = createLiveDriver(
      stackWith(fakeStreamFetch({ batch: [], missingReads: Number.POSITIVE_INFINITY })),
    );
    await expect(
      driver.observeUntil(RELATIVE_STREAM, () => false, { timeoutMs: 1_200 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("isStreamNotFound", () => {
  it("matches the client's FetchError-shaped 404 and nothing else", () => {
    expect(isStreamNotFound({ status: 404 })).toBe(true);
    expect(isStreamNotFound({ status: 401 })).toBe(false);
    expect(isStreamNotFound(new Error("nope"))).toBe(false);
    expect(isStreamNotFound(null)).toBe(false);
  });
});

describe("liveTestTimeout sanity (duplicated intent lives in index.test.ts)", () => {
  it("always strictly exceeds the observe window it wraps", () => {
    const stack = readStackConfig({ TEASPILL_STACK_URL: BASE_URL });
    expect(liveTestTimeout(stack)).toBe(stack!.timeoutMs + LIVE_TEST_TIMEOUT_MARGIN_MS);
  });
});
