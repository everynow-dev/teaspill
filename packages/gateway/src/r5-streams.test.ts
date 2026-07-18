/**
 * 0001:R5 integration test (PLAN §4 0001:R5 / T1.2a): streaming resumability must
 * survive the gateway. A client read is killed mid-long-poll and resumed
 * via offset THROUGH the gateway, asserting zero data loss, no duplication,
 * and untouched long-poll/ETag/offset semantics.
 *
 * Runs in two modes:
 *
 * 1. ALWAYS — against `FakeDurableStreams` (src/testing/fake-durable-streams.ts),
 *    a faithful in-memory port of the pinned Rust server's HTTP contract
 *    (headers/status/offset semantics read from
 *    `../electric/packages/durable-streams-rust/src/handlers.rs`).
 *
 * 2. WHEN `TEASPILL_R5_REAL_DS_URL` IS SET — the same suite against a REAL
 *    durable-streams server (the compose image), e.g.:
 *
 *      docker run --rm -d -p 14437:4437 -e DS_SERVER__PORT=4437 \
 *        electricax/durable-streams-server-rust:0.1.4
 *      TEASPILL_R5_REAL_DS_URL=http://127.0.0.1:14437 pnpm --filter @teaspill/gateway test
 *
 *    (The fake-only long-poll-timeout case is skipped there: the real
 *    server's park is 30 s, too slow for a unit-test budget.)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeDurableStreams, formatOffset } from "./testing/fake-durable-streams.js";
import { authHeader, listeningGateway, testConfig } from "./testing/test-support.js";
import { newInstanceId } from "./addressing.js";

const REAL_DS_URL = process.env.TEASPILL_R5_REAL_DS_URL;

const CACHEABLE = "public, max-age=60, stale-while-revalidate=300";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Ctx {
  gatewayUrl: string;
  app: FastifyInstance;
  restartGateway: () => Promise<void>;
  streamPath: string; // durable-streams server key
  fake: FakeDurableStreams | null;
}

function r5Suite(
  label: string,
  setup: () => Promise<Ctx>,
  teardown: (ctx: Ctx) => Promise<void>,
): void {
  describe(`0001:R5 through the gateway — ${label}`, () => {
    let ctx: Ctx;
    const H = authHeader;
    const gw = (): string => `${ctx.gatewayUrl}/streams${ctx.streamPath}`;

    beforeAll(async () => {
      ctx = await setup();
    });
    afterAll(async () => {
      await teardown(ctx);
    });

    // Offsets asserted with the protocol's exact %016d_%016d wire format.
    const o = (n: number): string => formatOffset(n);

    it("creates the stream through the gateway (PUT, C3)", async () => {
      const res = await fetch(gw(), {
        method: "PUT",
        headers: { ...H, "content-type": "text/plain" },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("stream-next-offset")).toBe(o(0));
      await res.arrayBuffer();
    });

    it("appends through the gateway (POST) and reports the exact next offset", async () => {
      const res = await fetch(gw(), {
        method: "POST",
        headers: { ...H, "content-type": "text/plain" },
        body: "one,",
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("stream-next-offset")).toBe(o(4));
    });

    let firstEtag: string;

    it("catch-up read: body, offset header, ETag, and Cache-Control pass through untouched", async () => {
      const res = await fetch(gw(), { headers: H });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("one,");
      expect(res.headers.get("stream-next-offset")).toBe(o(4));
      expect(res.headers.get("stream-up-to-date")).toBe("true");
      expect(res.headers.get("cache-control")).toBe(CACHEABLE);
      const etag = res.headers.get("etag");
      expect(etag).toBeTruthy();
      firstEtag = etag!;
    });

    it("conditional revalidation survives the proxy (If-None-Match → 304)", async () => {
      const res = await fetch(gw(), {
        headers: { ...H, "if-none-match": firstEtag },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(firstEtag);
      expect(res.headers.get("stream-next-offset")).toBe(o(4));
      await res.arrayBuffer();
    });

    it("long-poll with backlog returns immediately with data + cursor", async () => {
      const res = await fetch(`${gw()}?offset=${o(0)}&live=long-poll`, { headers: H });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("one,");
      expect(res.headers.get("stream-next-offset")).toBe(o(4));
      expect(res.headers.get("stream-cursor")).toMatch(/^\d+$/);
      expect(res.headers.get("etag")).toBeTruthy();
    });

    it("a PARKED long-poll stays open through the gateway and wakes on append", async () => {
      let settled = false;
      const parked = fetch(`${gw()}?offset=${o(4)}&live=long-poll`, { headers: H }).then((r) => {
        settled = true;
        return r;
      });
      await sleep(300);
      // Still parked: the gateway has not timed out, buffered, or answered early.
      expect(settled).toBe(false);

      const append = await fetch(gw(), {
        method: "POST",
        headers: { ...H, "content-type": "text/plain" },
        body: "two,",
      });
      expect(append.status).toBe(204);

      const res = await parked;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("two,"); // ONLY the new bytes — no replay
      expect(res.headers.get("stream-next-offset")).toBe(o(8));
    });

    it("KILL the client mid-long-poll, then RESUME via offset: no loss, no duplication", async () => {
      // 1. Client parks a long-poll at the current tail…
      const ac = new AbortController();
      const parked = fetch(`${gw()}?offset=${o(8)}&live=long-poll`, {
        headers: H,
        signal: ac.signal,
      });
      await sleep(150);

      // 2. …and dies (aborted read — the "kill" of 0001:R5).
      ac.abort();
      await expect(parked).rejects.toThrow();

      // 3. Data arrives while the client is gone.
      const append = await fetch(gw(), {
        method: "POST",
        headers: { ...H, "content-type": "text/plain" },
        body: "three,",
      });
      expect(append.status).toBe(204);
      expect(append.headers.get("stream-next-offset")).toBe(o(14));

      // 4. The client resumes FROM ITS LAST OFFSET through the gateway and
      //    receives exactly the bytes it missed.
      const resumed = await fetch(`${gw()}?offset=${o(8)}&live=long-poll`, { headers: H });
      expect(resumed.status).toBe(200);
      expect(await resumed.text()).toBe("three,");
      expect(resumed.headers.get("stream-next-offset")).toBe(o(14));

      // 5. Full-stream re-read: nothing was lost or duplicated end-to-end.
      const full = await fetch(gw(), { headers: H });
      expect(await full.text()).toBe("one,two,three,");
    });

    it("survives a GATEWAY restart mid-read: resume from offset on the new instance", async () => {
      await ctx.restartGateway();

      const append = await fetch(gw(), {
        method: "POST",
        headers: { ...H, "content-type": "text/plain" },
        body: "four,",
      });
      expect(append.status).toBe(204);

      // Resume from the pre-restart offset — continuity is carried entirely
      // by the protocol (offset), not by any gateway state.
      const res = await fetch(`${gw()}?offset=${o(14)}`, { headers: H });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("four,");
      expect(res.headers.get("stream-next-offset")).toBe(o(19));
    });

    it("client-supplied cursor and query string reach the upstream byte-exact (fake only)", async (t) => {
      if (!ctx.fake) return t.skip();
      const query = `offset=${o(19)}&live=long-poll&cursor=42`;
      const res = await fetch(`${gw()}?${query}`, { headers: H });
      expect([200, 204]).toContain(res.status);
      const seen = ctx.fake.requests.filter((r) => r.url === `${ctx.streamPath}?${query}`);
      expect(seen.length).toBeGreaterThan(0);
      await res.arrayBuffer();
    });

    it("long-poll TIMEOUT passes through as 204 without advancing the offset (fake only)", async (t) => {
      if (!ctx.fake) return t.skip();
      const before = Date.now();
      const res = await fetch(`${gw()}?offset=${o(19)}&live=long-poll`, { headers: H });
      const elapsed = Date.now() - before;
      expect(res.status).toBe(204);
      expect(elapsed).toBeGreaterThanOrEqual(700); // actually parked, not answered early
      expect(res.headers.get("stream-next-offset")).toBe(o(19)); // never skips bytes
      expect(res.headers.get("stream-up-to-date")).toBe("true");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("stream-cursor")).toMatch(/^\d+$/);
    });
  });
}

// ---------------------------------------------------------------------------
// Mode 1: faithful fake upstream (always runs)
// ---------------------------------------------------------------------------
{
  const fake = new FakeDurableStreams(800); // short park so the timeout case is testable
  let gwHandle: { app: FastifyInstance; url: string };
  let config: ReturnType<typeof testConfig>;

  r5Suite(
    "faithful fake durable-streams upstream",
    async () => {
      const upstream = await fake.listen();
      config = testConfig({ durableStreamsUrl: upstream });
      gwHandle = await listeningGateway(config);
      const ctx: Ctx = {
        gatewayUrl: gwHandle.url,
        app: gwHandle.app,
        streamPath: "/t/default/agents/researcher/r5-test/timeline",
        fake,
        restartGateway: async () => {
          await gwHandle.app.close();
          gwHandle = await listeningGateway(config);
          ctx.gatewayUrl = gwHandle.url;
          ctx.app = gwHandle.app;
        },
      };
      return ctx;
    },
    async (ctx) => {
      await ctx.app.close();
      await fake.close();
    },
  );
}

// ---------------------------------------------------------------------------
// Mode 2: real durable-streams server (env-gated)
// ---------------------------------------------------------------------------
if (REAL_DS_URL) {
  let gwHandle: { app: FastifyInstance; url: string };
  let config: ReturnType<typeof testConfig>;

  r5Suite(
    `REAL durable-streams server at ${REAL_DS_URL}`,
    async () => {
      config = testConfig({ durableStreamsUrl: REAL_DS_URL });
      gwHandle = await listeningGateway(config);
      const ctx: Ctx = {
        gatewayUrl: gwHandle.url,
        app: gwHandle.app,
        // Unique per run — the real server's streams persist.
        streamPath: `/t/default/agents/r5test/${newInstanceId()}/timeline`,
        fake: null,
        restartGateway: async () => {
          await gwHandle.app.close();
          gwHandle = await listeningGateway(config);
          ctx.gatewayUrl = gwHandle.url;
          ctx.app = gwHandle.app;
        },
      };
      return ctx;
    },
    async (ctx) => {
      await ctx.app.close();
    },
  );
}
