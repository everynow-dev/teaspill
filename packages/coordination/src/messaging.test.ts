/**
 * T2.3 messaging/spawn/pub-sub — unit tests against in-memory fakes (the
 * cron.test.ts / agent.test.ts pattern: the same functions the real
 * `restate.object` wiring calls, exercised on a structural fake context that
 * persists K/V across "invocations").
 *
 * The mandatory regression is `describe("parallel-spawn fan-out (regression)")`:
 * a parent spawns N children in ONE wake and each `child_finished` arrives as
 * a SEPARATE invocation — the exact upstream bug class (dropped parent wakes on
 * parallel sub-agent spawn). We assert all N are delivered and gathered, and
 * that redelivery never double-counts.
 *
 * What these tests deliberately do NOT cover (live-Restate behaviors → T6.3 /
 * T9.1): real delayed-send timing of the debounce `notifyTick`, exactly-once
 * dedup of one-way sends on a live server, and a real catalog-backed
 * `EntityDirectory` (`createDrizzleEntityDirectory`, exercised against Postgres
 * elsewhere). The dead-letter DETECTION logic is fully covered here against the
 * in-memory directory.
 */

import { describe, expect, it } from "vitest";
import {
  checkSeqContiguity,
  type ContentBlock,
  type TimelineEventInit,
} from "@teaspill/schema";
import { AGENT_KV, type AgentRuntimeCtx } from "./agent-runtime.js";
import { InMemoryProjectionOutbox, createAgentNotifier } from "./agent-seams.js";
import {
  InMemoryEntityDirectory,
  MESSAGING_KV,
  accumulateChildResult,
  createGather,
  gatherRemaining,
  handleSubscriberNotifyTick,
  isGatherComplete,
  notifyParentOrDeadLetter,
  recordGatherResult,
  scheduleSubscriberNotify,
  sendToAgent,
  spawnChild,
} from "./messaging.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface SentCall {
  service: string;
  method: string;
  key?: string;
  parameter: unknown;
  delay?: number;
}

/**
 * One virtual-object key's fake world: a K/V map that persists across
 * `ctx()` calls (each modeling a separate exclusive invocation) and a captured
 * send log.
 */
class FakeWorld {
  readonly state = new Map<string, unknown>();
  readonly sent: SentCall[] = [];
  constructor(readonly key: string) {}

  ctx(invocationId = "inv"): AgentRuntimeCtx {
    const state = this.state;
    const sent = this.sent;
    return {
      key: this.key,
      invocationId,
      runAbortSignal: new AbortController().signal,
      async get<T>(name: string): Promise<T | null> {
        return state.has(name) ? (state.get(name) as T) : null;
      },
      set<T>(name: string, value: T): void {
        state.set(name, value);
      },
      clear(name: string): void {
        state.delete(name);
      },
      async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
        return action();
      },
      genericSend(call: SentCall): void {
        sent.push(call);
      },
      raceInterrupt<T>(work: Promise<T>): Promise<T> {
        return work;
      },
    };
  }

  kv<T>(name: string): T | null {
    return this.state.has(name) ? (this.state.get(name) as T) : null;
  }
}

const url = (id: string, type = "default"): string => `/t/default/a/${type}/${id}`;
const NOW = "2026-07-17T00:00:00.000Z";
const text = (t: string): ContentBlock[] => [{ type: "text", text: t }];

/** Seed an entity as spawned (entity_spawned@0 on its stream) so later events start at seq 1. */
async function seedSpawned(
  outbox: InMemoryProjectionOutbox,
  ctx: AgentRuntimeCtx,
  entityId: string,
): Promise<void> {
  await outbox.stage(ctx, entityId, [
    { type: "entity_spawned", ts: NOW, payload: { entityType: "default", parentId: null } },
  ]);
  await outbox.flush(ctx, entityId);
  ctx.set(AGENT_KV.status, "idle");
}

// ---------------------------------------------------------------------------
// send — arbitrary inter-agent one-way message
// ---------------------------------------------------------------------------

describe("sendToAgent (the `send` verb)", () => {
  it("delivers a plain message to a live target (one-way, from = sender)", async () => {
    const world = new FakeWorld("sender-1");
    const ctx = world.ctx();
    const outbox = new InMemoryProjectionOutbox();
    await seedSpawned(outbox, ctx, url("sender-1"));
    const directory = new InMemoryEntityDirectory().set(url("peer-1"), "idle");

    const res = await sendToAgent(ctx, {
      outbox,
      directory,
      notifier: createAgentNotifier(),
      senderId: url("sender-1"),
      to: url("peer-1"),
      content: text("hi peer"),
    });

    expect(res).toEqual({ delivered: true, targetStatus: "idle" });
    const send = world.sent.find((s) => s.method === "message");
    expect(send).toMatchObject({
      service: "agent.default",
      key: "peer-1",
      parameter: { kind: "message", from: url("sender-1"), content: text("hi peer") },
    });
    // No dead-letter error on the sender.
    expect(outbox.timeline(url("sender-1")).some((e) => e.type === "error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dead-letter → error on the SENDER's timeline (never silent, D2)
// ---------------------------------------------------------------------------

describe("dead-letter (error on the sender's timeline)", () => {
  async function fresh(): Promise<{
    world: FakeWorld;
    ctx: AgentRuntimeCtx;
    outbox: InMemoryProjectionOutbox;
  }> {
    const world = new FakeWorld("sender-1");
    const ctx = world.ctx();
    const outbox = new InMemoryProjectionOutbox();
    await seedSpawned(outbox, ctx, url("sender-1"));
    return { world, ctx, outbox };
  }

  it("a send to a nonexistent target stages an error(source=platform) and delivers nothing", async () => {
    const { world, ctx, outbox } = await fresh();
    const directory = new InMemoryEntityDirectory(); // target unknown

    const res = await sendToAgent(ctx, {
      outbox,
      directory,
      notifier: createAgentNotifier(),
      senderId: url("sender-1"),
      to: url("ghost"),
      content: text("anyone home?"),
    });

    expect(res).toEqual({ delivered: false, reason: "not_found", targetStatus: null });
    expect(world.sent.some((s) => s.method === "message")).toBe(false); // never delivered
    const timeline = outbox.timeline(url("sender-1"));
    const err = timeline.find((e) => e.type === "error");
    expect(err).toMatchObject({
      payload: { source: "platform", code: "dead_letter", detail: { to: url("ghost"), reason: "not_found" } },
    });
    expect(checkSeqContiguity(timeline).ok).toBe(true);
  });

  it("a send to an archived target dead-letters (dead_status)", async () => {
    const { ctx, outbox } = await fresh();
    const directory = new InMemoryEntityDirectory().set(url("gone"), "archived");

    const res = await sendToAgent(ctx, {
      outbox,
      directory,
      notifier: createAgentNotifier(),
      senderId: url("sender-1"),
      to: url("gone"),
      content: text("hello?"),
    });

    expect(res).toEqual({ delivered: false, reason: "dead_status", targetStatus: "archived" });
    expect(outbox.timeline(url("sender-1")).find((e) => e.type === "error")).toMatchObject({
      payload: { detail: { reason: "dead_status", status: "archived" } },
    });
  });

  it("a send to a non-canonical url dead-letters (invalid_target) without a directory lookup", async () => {
    const { ctx, outbox } = await fresh();
    const res = await sendToAgent(ctx, {
      outbox,
      directory: new InMemoryEntityDirectory(),
      notifier: createAgentNotifier(),
      senderId: url("sender-1"),
      to: "garbage",
      content: text("x"),
    });
    expect(res).toEqual({ delivered: false, reason: "invalid_target" });
    expect(outbox.timeline(url("sender-1")).find((e) => e.type === "error")).toMatchObject({
      payload: { detail: { reason: "invalid_target" } },
    });
  });

  it("`archived` is overridable via deadStatuses (forward-compat with T8.1 resurrection)", async () => {
    const { world, ctx, outbox } = await fresh();
    const directory = new InMemoryEntityDirectory().set(url("napping"), "archived");
    const res = await sendToAgent(ctx, {
      outbox,
      directory,
      notifier: createAgentNotifier(),
      senderId: url("sender-1"),
      to: url("napping"),
      content: text("wake up"),
      deadStatuses: [], // T8.1: an archived entity resurrects on message
    });
    expect(res).toEqual({ delivered: true, targetStatus: "archived" });
    expect(world.sent.some((s) => s.method === "message")).toBe(true);
    expect(outbox.timeline(url("sender-1")).some((e) => e.type === "error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// child_finished back-send with dead-letter
// ---------------------------------------------------------------------------

describe("notifyParentOrDeadLetter", () => {
  it("delivers child_finished to a live parent", async () => {
    const world = new FakeWorld("child-1");
    const ctx = world.ctx();
    const outbox = new InMemoryProjectionOutbox();
    await seedSpawned(outbox, ctx, url("child-1"));
    const directory = new InMemoryEntityDirectory().set(url("parent-1"), "idle");

    const res = await notifyParentOrDeadLetter(ctx, {
      outbox,
      directory,
      notifier: createAgentNotifier(),
      childId: url("child-1"),
      parentRef: url("parent-1"),
      note: { childId: url("child-1"), outcome: "success", result: { ok: true } },
    });

    expect(res.delivered).toBe(true);
    expect(world.sent.find((s) => s.method === "message")).toMatchObject({
      key: "parent-1",
      parameter: { kind: "child_finished", childId: url("child-1"), outcome: "success" },
    });
  });

  it("dead-letters onto the CHILD's timeline when the parent is gone", async () => {
    const world = new FakeWorld("child-1");
    const ctx = world.ctx();
    const outbox = new InMemoryProjectionOutbox();
    await seedSpawned(outbox, ctx, url("child-1"));

    const res = await notifyParentOrDeadLetter(ctx, {
      outbox,
      directory: new InMemoryEntityDirectory(), // parent unknown
      notifier: createAgentNotifier(),
      childId: url("child-1"),
      parentRef: url("parent-1"),
      note: { childId: url("child-1"), outcome: "success" },
    });

    expect(res).toEqual({ delivered: false, reason: "not_found", targetStatus: null });
    expect(world.sent.some((s) => s.method === "message")).toBe(false);
    expect(outbox.timeline(url("child-1")).find((e) => e.type === "error")).toMatchObject({
      payload: { source: "platform", detail: { verb: "child_finished", reason: "not_found" } },
    });
  });
});

// ---------------------------------------------------------------------------
// spawnChild — parent→child one-way spawn + child_spawned event
// ---------------------------------------------------------------------------

describe("spawnChild", () => {
  it("fires a one-way spawn send carrying parentRef and returns the child_spawned event", async () => {
    const world = new FakeWorld("parent-1");
    const ctx = world.ctx();

    const event = await spawnChild(ctx, {
      childRef: url("child-7", "worker"),
      parentRef: url("parent-1"),
      args: { task: "crunch" },
      workspaceRef: "default/ws-1",
      runId: "run-abc",
      toolUseId: "tu-1",
    });

    // The spawn send: agent.<childType> keyed by <childId>, carrying parentRef.
    const spawn = world.sent.find((s) => s.method === "spawn");
    expect(spawn).toMatchObject({
      service: "agent.worker",
      key: "child-7",
      parameter: {
        parentRef: url("parent-1"),
        args: { task: "crunch" },
        workspaceRef: "default/ws-1",
      },
    });
    expect(spawn!.delay).toBeUndefined(); // immediate one-way send

    // The child_spawned event the parent commits to ITS timeline.
    expect(event).toMatchObject({
      type: "child_spawned",
      payload: { childId: url("child-7", "worker"), childType: "worker", runId: "run-abc", toolUseId: "tu-1" },
    });
  });

  it("rejects a non-canonical child url", async () => {
    const world = new FakeWorld("parent-1");
    await expect(
      spawnChild(world.ctx(), { childRef: "nope", parentRef: url("parent-1") }),
    ).rejects.toThrow(/canonical child url/);
  });
});

// ---------------------------------------------------------------------------
// gather N results — the fan-out accumulator state machine
// ---------------------------------------------------------------------------

describe("gather N results", () => {
  it("pure state machine: idempotent by childId, completes at expected", () => {
    let g = createGather(2);
    expect(isGatherComplete(g)).toBe(false);
    expect(gatherRemaining(g)).toBe(2);
    g = recordGatherResult(g, { childId: url("a"), outcome: "success" });
    g = recordGatherResult(g, { childId: url("a"), outcome: "success" }); // dup ignored
    expect(g.results).toHaveLength(1);
    expect(gatherRemaining(g)).toBe(1);
    g = recordGatherResult(g, { childId: url("b"), outcome: "error" });
    expect(isGatherComplete(g)).toBe(true);
    expect(gatherRemaining(g)).toBe(0);
  });

  it("accumulateChildResult persists across separate invocations and completes at N", async () => {
    const world = new FakeWorld("parent-1");
    const slot = "gather:demo";
    // First arrival initializes the slot from { expected }.
    const r1 = await accumulateChildResult(
      world.ctx("inv-1"),
      slot,
      { childId: url("c0"), outcome: "success" },
      { expected: 3 },
    );
    expect(r1.complete).toBe(false);
    expect(r1.remaining).toBe(2);
    const r2 = await accumulateChildResult(world.ctx("inv-2"), slot, {
      childId: url("c1"),
      outcome: "success",
    });
    expect(r2.complete).toBe(false);
    const r3 = await accumulateChildResult(world.ctx("inv-3"), slot, {
      childId: url("c2"),
      outcome: "success",
    });
    expect(r3.complete).toBe(true);
    expect(r3.state.results.map((r) => r.childId).sort()).toEqual([url("c0"), url("c1"), url("c2")]);
  });

  it("throws if a slot is used before initialization", async () => {
    const world = new FakeWorld("parent-1");
    await expect(
      accumulateChildResult(world.ctx(), "gather:x", { childId: url("a"), outcome: "success" }),
    ).rejects.toThrow(/uninitialized/);
  });
});

// ---------------------------------------------------------------------------
// subscriber-notify debounce (delayed self-send + dirty flag + gen guard)
// ---------------------------------------------------------------------------

describe("subscriber-notify debounce", () => {
  it("coalesces a burst of state changes into a single fan-out (generation guard)", async () => {
    const world = new FakeWorld("i-1");
    const ctx = world.ctx();
    ctx.set(AGENT_KV.subscribers, [url("wa"), url("wb")]);
    ctx.set(AGENT_KV.seq, 5); // head seq 4
    ctx.set(AGENT_KV.status, "idle");
    const notifier = createAgentNotifier();
    const entityId = url("i-1");

    // A burst of three state changes arms three ticks; only the last gen wins.
    const g1 = await scheduleSubscriberNotify(ctx, { service: "agent.default", debounceMs: 250 });
    const g2 = await scheduleSubscriberNotify(ctx, { service: "agent.default", debounceMs: 250 });
    const g3 = await scheduleSubscriberNotify(ctx, { service: "agent.default", debounceMs: 250 });
    expect([g1, g2, g3]).toEqual([1, 2, 3]);
    expect(world.sent.filter((s) => s.method === "notifyTick")).toHaveLength(3);
    expect(world.kv<boolean>(MESSAGING_KV.notifyDirty)).toBe(true);

    world.sent.length = 0;
    // The two earlier ticks are stale — pure no-ops.
    expect(await handleSubscriberNotifyTick(ctx, { entityId, notifier, msg: { gen: g1 } })).toEqual({
      notified: 0,
      reason: "stale-gen",
    });
    expect(await handleSubscriberNotifyTick(ctx, { entityId, notifier, msg: { gen: g2 } })).toEqual({
      notified: 0,
      reason: "stale-gen",
    });
    expect(world.sent).toHaveLength(0);

    // The latest tick fires ONE fan-out to both subscribers with the head seq.
    expect(await handleSubscriberNotifyTick(ctx, { entityId, notifier, msg: { gen: g3 } })).toEqual({
      notified: 2,
    });
    const updates = world.sent.filter(
      (s) => (s.parameter as { kind?: string }).kind === "subscription_update",
    );
    expect(updates.map((u) => u.key).sort()).toEqual(["wa", "wb"]);
    expect(updates[0]!.parameter).toMatchObject({ entityId, headSeq: 4, status: "idle" });

    // The dirty flag is cleared → a re-fire of the same tick is a no-op.
    world.sent.length = 0;
    expect(await handleSubscriberNotifyTick(ctx, { entityId, notifier, msg: { gen: g3 } })).toEqual({
      notified: 0,
      reason: "not-dirty",
    });
    expect(world.sent).toHaveLength(0);
  });

  it("a tick with no subscribers clears dirty and notifies nothing", async () => {
    const world = new FakeWorld("i-1");
    const ctx = world.ctx();
    ctx.set(AGENT_KV.subscribers, []);
    const gen = await scheduleSubscriberNotify(ctx, { service: "agent.default", debounceMs: 100 });
    expect(
      await handleSubscriberNotifyTick(ctx, {
        entityId: url("i-1"),
        notifier: createAgentNotifier(),
        msg: { gen },
      }),
    ).toEqual({ notified: 0, reason: "no-subscribers" });
    expect(world.kv<boolean>(MESSAGING_KV.notifyDirty)).toBeNull(); // cleared
  });
});

// ---------------------------------------------------------------------------
// parallel-spawn fan-out (regression) — the mandatory upstream bug-class test
// ---------------------------------------------------------------------------

describe("parallel-spawn fan-out (regression)", () => {
  it("a parent spawns N children in ONE wake; all N child_finished are delivered and gathered", async () => {
    const N = 4;
    const parentUrl = url("parent-1");
    const world = new FakeWorld("parent-1");
    const outbox = new InMemoryProjectionOutbox();
    const childUrls = Array.from({ length: N }, (_, i) => url(`child-${i}`, "worker"));

    // --- ONE parent wake: spawn N children in parallel + open the gather slot.
    const parentWake = world.ctx("inv-parent");
    await seedSpawned(outbox, parentWake, parentUrl);
    parentWake.set("gather:fanout", createGather(N));

    const childSpawnedEvents: TimelineEventInit[] = [];
    for (const childUrl of childUrls) {
      childSpawnedEvents.push(
        await spawnChild(parentWake, {
          childRef: childUrl,
          parentRef: parentUrl,
          args: { i: childUrl },
          runId: "run-parent",
        }),
      );
    }
    await outbox.stage(parentWake, parentUrl, childSpawnedEvents);
    await outbox.flush(parentWake, parentUrl);

    // N one-way spawn sends, each to agent.worker/<childId>, carrying parentRef.
    const spawnSends = world.sent.filter((s) => s.method === "spawn");
    expect(spawnSends).toHaveLength(N);
    expect(spawnSends.map((s) => s.key).sort()).toEqual(
      Array.from({ length: N }, (_, i) => `child-${i}`),
    );
    for (const s of spawnSends) {
      expect((s.parameter as { parentRef: string }).parentRef).toBe(parentUrl);
    }
    // N child_spawned events on the parent timeline.
    expect(outbox.timeline(parentUrl).filter((e) => e.type === "child_spawned")).toHaveLength(N);

    // --- N SEPARATE invocations: each child_finished arrives on its own wake.
    //     This is the exact bug class — none may be dropped or collide.
    let completedAt = -1;
    for (let i = 0; i < N; i++) {
      const wake = world.ctx(`inv-cf-${i}`);
      // The child_finished lands on the parent timeline (delivery)…
      await outbox.stage(wake, parentUrl, [
        {
          type: "child_finished",
          ts: NOW,
          payload: { childId: childUrls[i]!, outcome: "success", result: { i } },
        },
      ]);
      await outbox.flush(wake, parentUrl);
      // …and the parent gathers it (accumulation across invocations).
      const acc = await accumulateChildResult(wake, "gather:fanout", {
        childId: childUrls[i]!,
        outcome: "success",
        result: { i },
      });
      if (acc.complete && completedAt < 0) completedAt = i;
    }

    // Completion happens exactly at the LAST child, not before.
    expect(completedAt).toBe(N - 1);

    const gather = world.kv<{ results: { childId: string }[] }>("gather:fanout")!;
    expect(gather.results.map((r) => r.childId).sort()).toEqual([...childUrls].sort());

    const timeline = outbox.timeline(parentUrl);
    expect(timeline.filter((e) => e.type === "child_finished")).toHaveLength(N);
    expect(checkSeqContiguity(timeline).ok).toBe(true); // zero seq collisions across N wakes
  });

  it("a redelivered child_finished never double-counts the gather (idempotent by childId)", async () => {
    const world = new FakeWorld("parent-1");
    world.ctx("seed").set("gather:fanout", createGather(2));

    await accumulateChildResult(world.ctx("inv-a"), "gather:fanout", {
      childId: url("a"),
      outcome: "success",
    });
    // Same child delivered twice (at-least-once / wake retry).
    const dup = await accumulateChildResult(world.ctx("inv-a-again"), "gather:fanout", {
      childId: url("a"),
      outcome: "success",
    });
    expect(dup.complete).toBe(false);
    expect(dup.state.results).toHaveLength(1);

    const done = await accumulateChildResult(world.ctx("inv-b"), "gather:fanout", {
      childId: url("b"),
      outcome: "success",
    });
    expect(done.complete).toBe(true);
  });
});
