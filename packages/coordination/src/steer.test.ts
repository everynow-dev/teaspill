/**
 * 0001:T2.6 steerbox — unit tests against in-memory fakes (the cron.ts /
 * messaging.ts pattern: the same `handlePush`/`handleDrain` functions the
 * real `restate.object(...)` wiring calls, exercised on a structural fake
 * context that persists K/V across "invocations").
 *
 * What these tests deliberately do NOT cover (live-Restate behaviors →
 * 0001:T6.3/0001:T9.1): real Restate delayed/concurrent delivery ordering under
 * genuine concurrent `push` invocations (single-writer-per-key makes this a
 * server guarantee, not app logic to test here), real HTTP transport
 * against a live ingress (the `createHttpSteerSource` fetch plumbing is
 * exercised against an in-memory mock server below, not a live one).
 */

import { describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "@teaspill/schema";
import { emptySteerSource } from "./agent-seams.js";
import {
  STEER_KV,
  STEER_SERVICE_NAME,
  type SteerRuntimeCtx,
  createHttpSteerSource,
  decideSteerRoute,
  drainAtWakeStart,
  handleDrain,
  handlePush,
  renderSteerMessagesAsEvents,
  steerTarget,
} from "./steer.js";

// ---------------------------------------------------------------------------
// Fake context (cron.ts FakeCronCtx pattern)
// ---------------------------------------------------------------------------

class FakeSteerCtx implements SteerRuntimeCtx {
  readonly key: string;
  private readonly state = new Map<string, unknown>();

  constructor(key: string) {
    this.key = key;
  }

  async get<T>(name: string): Promise<T | null> {
    return this.state.has(name) ? (this.state.get(name) as T) : null;
  }

  set<T>(name: string, value: T): void {
    this.state.set(name, value);
  }

  clear(name: string): void {
    this.state.delete(name);
  }

  async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
    return action();
  }
}

const text = (s: string): ContentBlock[] => [{ type: "text", text: s }];

// ---------------------------------------------------------------------------
// push -> drain: ordering + clearing
// ---------------------------------------------------------------------------

describe("handlePush / handleDrain", () => {
  it("a single push is returned by drain and the queue is then empty", async () => {
    const ctx = new FakeSteerCtx("/t/default/a/researcher/i-1");
    const pushed = await handlePush(ctx, { content: text("hello") });
    expect(pushed).toEqual({ ordinal: 0, queued: 1 });

    const drained = await handleDrain(ctx);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.content).toEqual(text("hello"));
    expect(drained[0]!.id).toBe("steer-0");

    // Queue is now empty (cleared, not just observed as such).
    expect(await ctx.get(STEER_KV.queue)).toBeNull();
  });

  it("drain on an empty queue is a no-op: returns [] and performs no K/V write", async () => {
    const ctx = new FakeSteerCtx("/t/default/a/researcher/i-2");
    const setSpy = vi.spyOn(ctx, "set");
    const clearSpy = vi.spyOn(ctx, "clear");

    const drained = await handleDrain(ctx);
    expect(drained).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it("draining twice in a row without an intervening push: second drain is also a no-op ([])", async () => {
    const ctx = new FakeSteerCtx("/t/default/a/researcher/i-3");
    await handlePush(ctx, { content: text("one") });

    const first = await handleDrain(ctx);
    expect(first).toHaveLength(1);

    const second = await handleDrain(ctx);
    expect(second).toEqual([]);
  });

  it("preserves push order under multiple interleaved pushes before a single drain", async () => {
    const ctx = new FakeSteerCtx("/t/default/a/researcher/i-4");
    await handlePush(ctx, { content: text("a") });
    await handlePush(ctx, { content: text("b") });
    await handlePush(ctx, { content: text("c") });

    const drained = await handleDrain(ctx);
    expect(drained.map((m) => m.content)).toEqual([text("a"), text("b"), text("c")]);
    // Default ids reflect push order via the monotonic counter.
    expect(drained.map((m) => m.id)).toEqual(["steer-0", "steer-1", "steer-2"]);
  });

  it("the monotonic counter never resets across drain cycles (ordinals keep climbing)", async () => {
    const ctx = new FakeSteerCtx("/t/default/a/researcher/i-5");
    const r1 = await handlePush(ctx, { content: text("a") });
    await handleDrain(ctx);
    const r2 = await handlePush(ctx, { content: text("b") });
    const r3 = await handlePush(ctx, { content: text("c") });

    expect(r1.ordinal).toBe(0);
    expect(r2.ordinal).toBe(1);
    expect(r3.ordinal).toBe(2);

    const drained = await handleDrain(ctx);
    expect(drained.map((m) => m.id)).toEqual(["steer-1", "steer-2"]);
  });

  it("a caller-supplied id/ts/from is honored verbatim instead of the minted default", async () => {
    const ctx = new FakeSteerCtx("/t/default/a/researcher/i-6");
    await handlePush(ctx, {
      content: text("hi"),
      id: "provider-msg-42",
      ts: "2026-01-01T00:00:00.000Z",
      from: "/t/default/a/watcher/i-9",
    });
    const [msg] = await handleDrain(ctx);
    expect(msg).toEqual({
      id: "provider-msg-42",
      ts: "2026-01-01T00:00:00.000Z",
      content: text("hi"),
      from: "/t/default/a/watcher/i-9",
    });
  });

  it("two different steerbox keys never interfere with each other's queues", async () => {
    const ctxA = new FakeSteerCtx("/t/default/a/researcher/i-a");
    const ctxB = new FakeSteerCtx("/t/default/a/researcher/i-b");
    await handlePush(ctxA, { content: text("for-a") });

    expect(await handleDrain(ctxB)).toEqual([]);
    const drainedA = await handleDrain(ctxA);
    expect(drainedA).toHaveLength(1);
    expect(drainedA[0]!.content).toEqual(text("for-a"));
  });
});

// ---------------------------------------------------------------------------
// The race: a steer landing between run-end and next-wake-start is drained
// as the first input of the next wake (PLAN 0001:T2.6 anticipate — the no-loss
// contract). Simulated purely against the fake context + drainAtWakeStart;
// no live Restate server needed to demonstrate the sequencing.
// ---------------------------------------------------------------------------

describe("wake-start drain (no-loss race)", () => {
  it("a push that lands after the harness's own mid-run drains, before the next wake starts, is not lost", async () => {
    const ctx = new FakeSteerCtx("/t/default/a/researcher/i-race");

    // 1. Mid-run: the harness drains at its checkpoints and finds nothing.
    expect(await handleDrain(ctx)).toEqual([]);

    // 2. Run ends (agent.ts sets status back to idle here, out of scope for
    //    this module — see agent-runtime.ts AGENT_KV.status).

    // 3. A steer lands in the gap between run-end and the next wake.
    await handlePush(ctx, { content: text("late steer") });

    // 4. Next wake starts. The agent object's FIRST action (wake-start
    //    drain contract) is an unconditional drain via the SteerSource
    //    adapter — simulated here with a source bound directly to the fake
    //    ctx's drain, standing in for the HTTP-ingress adapter in
    //    production.
    const source = { drain: () => handleDrain(ctx) };
    const events = await drainAtWakeStart(source);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message",
      payload: { role: "user", content: text("late steer") },
    });

    // 5. The steerbox is now empty for the wake after that.
    expect(await handleDrain(ctx)).toEqual([]);
  });

  it("drainAtWakeStart on an entity with nothing queued returns an empty event list (ordinary wakes are unaffected)", async () => {
    const events = await drainAtWakeStart(emptySteerSource);
    expect(events).toEqual([]);
  });

  it("renderSteerMessagesAsEvents renders id/role/content/from in the same shape agent.ts uses for wake-input messages", () => {
    const events = renderSteerMessagesAsEvents([
      { id: "m1", ts: "2026-01-01T00:00:00.000Z", content: text("x"), from: "/t/default/a/w/i-1" },
      { id: "m2", ts: "2026-01-01T00:00:01.000Z", content: text("y") },
    ]);
    expect(events).toEqual([
      {
        type: "message",
        ts: "2026-01-01T00:00:00.000Z",
        payload: { id: "m1", role: "user", content: text("x"), from: "/t/default/a/w/i-1" },
      },
      {
        type: "message",
        ts: "2026-01-01T00:00:01.000Z",
        payload: { id: "m2", role: "user", content: text("y") },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Routing decision: mid-run -> steer, idle/archived/unknown -> degrade to a
// normal message wake (0001:D2, PLAN 0001:T2.6).
// ---------------------------------------------------------------------------

describe("decideSteerRoute", () => {
  const entityId = "/t/default/a/researcher/i-1";
  const input = { content: text("steer me"), from: "/t/default/a/watcher/i-2" };

  it("routes to the steerbox when the entity is active (mid-run)", () => {
    const decision = decideSteerRoute(entityId, "active", input);
    expect(decision).toEqual({ route: "steer", target: steerTarget(entityId) });
    expect(decision).toMatchObject({ target: { service: STEER_SERVICE_NAME, key: entityId } });
  });

  it("degrades to a normal message wake with source steer_degraded when idle", () => {
    const decision = decideSteerRoute(entityId, "idle", input);
    expect(decision).toEqual({
      route: "message",
      delivery: {
        kind: "message",
        content: input.content,
        from: input.from,
        source: "steer_degraded",
      },
    });
  });

  it("degrades when archived (resurrection path, not a live run)", () => {
    const decision = decideSteerRoute(entityId, "archived", input);
    expect(decision.route).toBe("message");
  });

  it("degrades when status is unknown/unreadable (null) — never silently drops the send", () => {
    const decision = decideSteerRoute(entityId, null, input);
    expect(decision.route).toBe("message");
  });

  it("omits `from` on the degraded delivery when the caller didn't supply one", () => {
    const decision = decideSteerRoute(entityId, "idle", { content: text("no sender") });
    expect(decision).toEqual({
      route: "message",
      delivery: { kind: "message", content: text("no sender"), source: "steer_degraded" },
    });
    if (decision.route === "message") {
      expect(decision.delivery).not.toHaveProperty("from");
    }
  });
});

// ---------------------------------------------------------------------------
// SteerSource HTTP adapter — exercised against an in-memory mock "ingress"
// built directly from handlePush/handleDrain (no live Restate server; see
// module doc for what's deferred to 0001:T6.3/0001:T9.1).
// ---------------------------------------------------------------------------

describe("createHttpSteerSource", () => {
  function mockIngress() {
    const boxes = new Map<string, FakeSteerCtx>();
    const requests: string[] = [];
    const boxFor = (key: string): FakeSteerCtx => {
      let box = boxes.get(key);
      if (!box) {
        box = new FakeSteerCtx(key);
        boxes.set(key, box);
      }
      return box;
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      const parts = url.pathname.split("/").filter(Boolean); // ["steer", "<encoded-key>", "drain"]
      expect(parts[0]).toBe(STEER_SERVICE_NAME);
      expect(parts[2]).toBe("drain");
      const key = decodeURIComponent(parts[1]!);
      const drained = await handleDrain(boxFor(key));
      return new Response(JSON.stringify(drained), { status: 200 });
    };
    return { boxFor, requests, fetchImpl };
  }

  it("drains via a percent-encoded ingress path and returns the queued messages", async () => {
    const { boxFor, requests, fetchImpl } = mockIngress();
    const entityId = "/t/default/a/researcher/i-http";
    await handlePush(boxFor(entityId), { content: text("via http") });

    const source = createHttpSteerSource({ ingressUrl: "http://restate:8080", entityId, fetch: fetchImpl });
    const drained = await source.drain();

    expect(drained).toHaveLength(1);
    expect(drained[0]!.content).toEqual(text("via http"));
    expect(requests).toEqual([`/${STEER_SERVICE_NAME}/${encodeURIComponent(entityId)}/drain`]);
  });

  it("returns [] and clears nothing further when the box is already empty", async () => {
    const { fetchImpl } = mockIngress();
    const source = createHttpSteerSource({
      ingressUrl: "http://restate:8080",
      entityId: "/t/default/a/researcher/i-empty",
      fetch: fetchImpl,
    });
    expect(await source.drain()).toEqual([]);
  });

  it("throws with status + body on a non-ok response (transport surfaces failure, never swallows it)", async () => {
    const failingFetch: typeof fetch = async () => new Response("boom", { status: 500 });
    const source = createHttpSteerSource({
      ingressUrl: "http://restate:8080",
      entityId: "/t/default/a/researcher/i-fail",
      fetch: failingFetch,
    });
    await expect(source.drain()).rejects.toThrow(/500/);
  });

  it("rejects an empty entityId eagerly rather than constructing a malformed ingress path", () => {
    expect(() =>
      createHttpSteerSource({ ingressUrl: "http://restate:8080", entityId: "", fetch: vi.fn() as never }),
    ).toThrow(/entityId/);
  });
});

// ---------------------------------------------------------------------------
// steerTarget
// ---------------------------------------------------------------------------

describe("steerTarget", () => {
  it("maps an entity url to { service: 'steer', key: <url> } (https://teaspill.everynow.dev/reference/addressing)", () => {
    expect(steerTarget("/t/default/a/researcher/i-1")).toEqual({
      service: "steer",
      key: "/t/default/a/researcher/i-1",
    });
  });

  it("rejects an empty key", () => {
    expect(() => steerTarget("")).toThrow(/entityId/);
  });
});
