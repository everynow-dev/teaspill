/**
 * 0001:T2.1 agent virtual object — unit tests against in-memory fakes (the
 * cron.test.ts pattern: same handler functions the real `restate.object`
 * wiring calls, exercised on a structural fake context).
 *
 * What these tests deliberately do NOT cover (live-Restate behaviors,
 * deferred to the conformance kit 0001:T6.3 / failure injection 0001:T9.1):
 * real `ctx.cancel` delivery + `explicitCancellation` semantics of the
 * @experimental cancellation API, replay of a crashed `ctx.run`,
 * exactly-once dedup of durable sends, shared-vs-exclusive scheduling on a
 * real server, and per-handler inactivity/abort timeouts. The fake models
 * the SPIKE-verified behaviors: shared handlers see in-flight K/V writes
 * (SPIKE §a-2) and cancelling the recorded invocation rejects the
 * `raceInterrupt` seam while aborting the run's AbortSignal (SPIKE §a-3/5).
 */

import { describe, expect, it } from "vitest";
import {
  checkSeqContiguity,
  checkTimelineInvariants,
  type TimelineEventInit,
} from "@teaspill/schema";
import type { Harness } from "@teaspill/harness-native";
import {
  AGENT_KV,
  AgentInterruptedError,
  type AgentRuntimeCtx,
  type AgentSharedRuntimeCtx,
  type EntityStatus,
} from "./agent-runtime.js";
import {
  InMemoryProjectionOutbox,
  commitEventsChunked,
  createSendNotifier,
  createStubHarness,
} from "./agent-seams.js";
import {
  agentEntityUrl,
  agentServiceName,
  createAgentObject,
  handleArchiveTick,
  handleMessage,
  handleNotifyTick,
  handleSignal,
  handleSpawn,
  handleSubscribe,
  handleUnsubscribe,
  type AgentMessageInput,
  type AgentObjectConfig,
} from "./agent.js";

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
 * One virtual-object key's fake world: a shared K/V map (exclusive writes
 * are immediately visible to shared reads, per SPIKE §a-2), a captured send
 * log, and a cancel registry mapping invocation ids to their in-flight
 * exclusive contexts (modeling `ctx.cancel` reaching `raceInterrupt`).
 */
class FakeAgentWorld {
  readonly state = new Map<string, unknown>();
  readonly sent: SentCall[] = [];
  private readonly running = new Map<string, FakeExclusiveCtx>();

  constructor(readonly key: string) {}

  exclusiveCtx(invocationId: string): FakeExclusiveCtx {
    const ctx = new FakeExclusiveCtx(this, invocationId);
    this.running.set(invocationId, ctx);
    return ctx;
  }

  sharedCtx(): AgentSharedRuntimeCtx {
    return {
      key: this.key,
      get: async <T>(name: string): Promise<T | null> =>
        this.state.has(name) ? (this.state.get(name) as T) : null,
      cancelInvocation: (invocationId: string): void => {
        // Cancel-of-completed is a harmless no-op (server 409, SPIKE §a-3).
        this.running.get(invocationId)?.triggerInterrupt();
      },
      genericSend: (call): void => {
        this.sent.push(call);
      },
    };
  }

  kv<T>(name: string): T | null {
    return this.state.has(name) ? (this.state.get(name) as T) : null;
  }
}

class FakeExclusiveCtx implements AgentRuntimeCtx {
  readonly key: string;
  readonly invocationId: string;
  readonly runAbortSignal: AbortSignal;
  private readonly abort = new AbortController();
  private interruptReject: ((err: unknown) => void) | undefined;
  private interruptedEarly = false;

  constructor(
    private readonly world: FakeAgentWorld,
    invocationId: string,
  ) {
    this.key = world.key;
    this.invocationId = invocationId;
    this.runAbortSignal = this.abort.signal;
  }

  async get<T>(name: string): Promise<T | null> {
    return this.world.state.has(name) ? (this.world.state.get(name) as T) : null;
  }
  set<T>(name: string, value: T): void {
    this.world.state.set(name, value);
  }
  clear(name: string): void {
    this.world.state.delete(name);
  }
  async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
    return action();
  }
  genericSend(call: SentCall): void {
    this.world.sent.push(call);
  }
  raceInterrupt<T>(work: Promise<T>): Promise<T> {
    if (this.interruptedEarly) return Promise.reject(new AgentInterruptedError());
    const interrupted = new Promise<never>((_, reject) => {
      this.interruptReject = reject;
    });
    return Promise.race([work, interrupted]);
  }

  /** Test lever standing in for a real `ctx.cancel` on this invocation. */
  triggerInterrupt(): void {
    if (this.interruptReject) this.interruptReject(new AgentInterruptedError());
    else this.interruptedEarly = true;
    this.abort.abort(); // reaches the live harness closure (SPIKE §a-5)
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentObjectConfig> = {}): {
  config: AgentObjectConfig;
  outbox: InMemoryProjectionOutbox;
} {
  const outbox = (overrides.outbox as InMemoryProjectionOutbox) ?? new InMemoryProjectionOutbox();
  const config: AgentObjectConfig = {
    entityType: "default",
    harness: createStubHarness(),
    outbox,
    notifier: createSendNotifier(),
    ...overrides,
  };
  return { config, outbox };
}

const ENTITY = agentEntityUrl("default", "default", "i-1");

const userMessage = (text: string): AgentMessageInput => ({
  content: [{ type: "text", text }],
});

// ---------------------------------------------------------------------------
// Per-entity factory seams + workspaceRef exposure (0002:T4.2, additive)
// ---------------------------------------------------------------------------

describe("per-entity seams (0002:T4.2)", () => {
  it("steerSourceFactory wins over steerSource and receives the entity url; its drain feeds the wake", async () => {
    const world = new FakeAgentWorld("i-1");
    const factoryCalls: string[] = [];
    const { config, outbox } = makeConfig({
      steerSource: {
        drain: () => Promise.reject(new Error("per-TYPE source must not be drained when a factory is set")),
      },
      steerSourceFactory: ({ entityId }) => {
        factoryCalls.push(entityId);
        let drained = false;
        return {
          drain: async () => {
            if (drained) return [];
            drained = true;
            return [
              { id: "s-0", ts: "2026-07-18T00:00:00.000Z", content: [{ type: "text", text: "steered!" }] },
            ];
          },
        };
      },
    });

    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {}, parentRef: null });

    expect(factoryCalls).toEqual([ENTITY]);
    // The drained steer message is the FIRST pre-event (0001:T2.6 no-loss).
    const timeline = outbox.timeline(ENTITY);
    const first = timeline[0]!;
    expect(first.type).toBe("message");
    expect((first.payload as { id: string }).id).toBe("s-0");
  });

  it("emitDeltaFactory wins over emitDelta and its emitter reaches the harness input", async () => {
    const world = new FakeAgentWorld("i-1");
    const seen: string[] = [];
    const factoryEmitter = (): void => {
      seen.push("factory");
    };
    const { config } = makeConfig({
      emitDelta: () => {
        seen.push("config-level");
      },
      emitDeltaFactory: ({ entityId }) => {
        expect(entityId).toBe(ENTITY);
        return factoryEmitter;
      },
      harness: createStubHarness({
        produce: (input) => {
          input.emitDelta({ kind: "text", runId: "r", ref: "m", idx: 0, ts: "2026-07-18T00:00:00.000Z", text: "x" });
          return [];
        },
      }),
    });

    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {}, parentRef: null });
    expect(seen).toEqual(["factory"]);
  });

  it("absent factories preserve the pre-0002 per-type seams byte-identically", async () => {
    const world = new FakeAgentWorld("i-1");
    const seen: string[] = [];
    const { config } = makeConfig({
      emitDelta: () => {
        seen.push("config-level");
      },
      harness: createStubHarness({
        produce: (input) => {
          input.emitDelta({ kind: "text", runId: "r", ref: "m", idx: 0, ts: "2026-07-18T00:00:00.000Z", text: "x" });
          return [];
        },
      }),
    });
    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {}, parentRef: null });
    expect(seen).toEqual(["config-level"]);
  });

  it("exposes the spawn-chosen workspaceRef on OnWakeContext (absent when none)", async () => {
    const world = new FakeAgentWorld("i-1");
    const seen: (string | undefined)[] = [];
    const { config } = makeConfig({
      onWake: (wake) => {
        seen.push(wake.workspaceRef);
        return { handled: true };
      },
    });
    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, {
      args: {},
      parentRef: null,
      workspaceRef: "default/shared-ws",
    });
    await handleMessage(world.exclusiveCtx("inv-m1"), config, userMessage("go"));
    expect(seen).toEqual(["default/shared-ws", "default/shared-ws"]);

    const world2 = new FakeAgentWorld("i-1");
    const seen2: (string | undefined)[] = [];
    const { config: config2 } = makeConfig({
      onWake: (wake) => {
        seen2.push(wake.workspaceRef);
        return { handled: true };
      },
    });
    await handleSpawn(world2.exclusiveCtx("inv-spawn"), config2, { args: {}, parentRef: null });
    expect(seen2).toEqual([undefined]);
  });

  it("a live interrupt during an onWake-only wake winds down: signal aborts, control(interrupt) + run_finished(interrupted) land (0002:T4.2)", async () => {
    const world = new FakeAgentWorld("i-1");
    const ctx = world.exclusiveCtx("inv-spawn");
    const observed: boolean[] = [];
    const { config, outbox } = makeConfig({
      onWake: (wake) => {
        // A live `interrupt` verb lands mid-hook (ctx.cancel → abort).
        ctx.triggerInterrupt();
        observed.push(wake.signal!.aborted); // the hook SEES the abort...
        return { handled: true, outcome: "success" }; // ...and winds down normally
      },
    });

    const result = await handleSpawn(ctx, config, { args: {}, parentRef: null });

    expect(observed).toEqual([true]);
    // Interrupt WINS the outcome even though the hook claimed success.
    expect(result.outcome).toBe("interrupted");
    const timeline = outbox.timeline(ENTITY);
    const types = timeline.map((e) => e.type);
    expect(types.at(-2)).toBe("control");
    expect(types.at(-1)).toBe("run_finished");
    const control = timeline.at(-2)!;
    expect(control.type === "control" && control.payload.verb).toBe("interrupt");
    const finished = timeline.at(-1)!;
    expect(finished.type === "run_finished" && finished.payload.outcome).toBe("interrupted");
    expect(checkSeqContiguity(timeline).ok).toBe(true);
  });

  it("exposes the spawn-chosen workspaceRef on HarnessBuildContext (step-durable path)", async () => {
    const world = new FakeAgentWorld("i-1");
    const seen: (string | undefined)[] = [];
    const { config } = makeConfig({
      buildHarness: (build) => {
        seen.push(build.workspaceRef);
        return createStubHarness();
      },
    });
    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, {
      args: {},
      parentRef: null,
      workspaceRef: "default/shared-ws",
    });
    expect(seen).toEqual(["default/shared-ws"]);
  });
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe("handleSpawn", () => {
  it("writes entity_spawned at seq 0 through the outbox, runs the harness, and leaves a contiguous timeline", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config, outbox } = makeConfig();

    const result = await handleSpawn(world.exclusiveCtx("inv-spawn"), config, {
      args: { task: "hello" },
      parentRef: null,
    });

    expect(result.created).toBe(true);
    expect(result.entityId).toBe(ENTITY);
    expect(result.outcome).toBe("success");

    const timeline = outbox.timeline(ENTITY);
    // entity_spawned@0, message(user spawn args)@1, run_started@2, stub assistant@3, run_finished@4
    expect(timeline.map((e) => e.type)).toEqual([
      "entity_spawned",
      "message",
      "run_started",
      "message",
      "run_finished",
    ]);
    expect(timeline[0]!.seq).toBe(0);
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);
    expect(result.headSeq).toBe(4);

    // entity_spawned payload carries type/parent/args (0001:A5 schema).
    expect(timeline[0]).toMatchObject({
      entityId: ENTITY,
      payload: { entityType: "default", parentId: null, spawnArgs: { task: "hello" } },
    });
  });

  it("initializes the documented K/V layout and clears the interrupt target", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig();

    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, {
      args: { task: "hello" },
      parentRef: null,
      workspaceRef: "default/a-default-i-1",
    });

    expect(world.kv<EntityStatus>(AGENT_KV.status)).toBe("idle");
    expect(world.kv<number>(AGENT_KV.seq)).toBe(5); // next unallocated
    expect(world.kv(AGENT_KV.outbox)).toEqual([]); // flushed and trimmed
    expect(world.kv(AGENT_KV.parentRef)).toBeNull();
    expect(world.kv(AGENT_KV.workspaceRef)).toBe("default/a-default-i-1");
    expect(world.kv(AGENT_KV.subscribers)).toEqual([]);
    expect(world.kv(AGENT_KV.usage)).toMatchObject({ inputTokens: 3, outputTokens: 5 });
    expect(world.kv(AGENT_KV.currentInvocationId)).toBeNull();
    // Context holds exactly the context-bearing events (0001:D1 bounded context).
    const context = world.kv<Array<{ type: string }>>(AGENT_KV.context)!;
    expect(context.map((e) => e.type)).toEqual(["message", "message"]);
  });

  it("schedules the idle→archive tick with a fresh epoch (delayed self-send)", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig({ idleArchiveDelayMs: 60_000 });

    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {} });

    const tick = world.sent.find((s) => s.method === "archiveTick");
    expect(tick).toMatchObject({
      service: "agent.default",
      key: "i-1",
      parameter: { epoch: 1 },
      delay: 60_000,
    });
    expect(world.kv(AGENT_KV.archiveEpoch)).toBe(1);
  });

  it("re-spawn on an existing key is an idempotent no-op reattach (no re-init, no events)", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config, outbox } = makeConfig();

    await handleSpawn(world.exclusiveCtx("inv-1"), config, { args: { a: 1 } });
    const lenBefore = outbox.timeline(ENTITY).length;

    const again = await handleSpawn(world.exclusiveCtx("inv-2"), config, { args: { a: 2 } });
    expect(again.created).toBe(false);
    expect(again.headSeq).toBe(lenBefore - 1);
    expect(outbox.timeline(ENTITY)).toHaveLength(lenBefore);
  });

  it("notifies the parent (child_finished as a message send) when spawned with a parentRef", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig();
    const parent = agentEntityUrl("default", "default", "parent-1");

    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {}, parentRef: parent });

    const send = world.sent.find(
      (s) => s.method === "message" && (s.parameter as { kind?: string }).kind === "child_finished",
    );
    expect(send).toMatchObject({
      service: "agent.default",
      key: "parent-1",
      parameter: { kind: "child_finished", childId: ENTITY, outcome: "success" },
    });
  });
});

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

describe("handleMessage", () => {
  async function spawned(): Promise<{
    world: FakeAgentWorld;
    config: AgentObjectConfig;
    outbox: InMemoryProjectionOutbox;
  }> {
    const world = new FakeAgentWorld("i-1");
    const { config, outbox } = makeConfig();
    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: { task: "hi" } });
    return { world, config, outbox };
  }

  it("an ordinary wake records the user message, runs the harness, and continues seq contiguously", async () => {
    const { world, config, outbox } = await spawned();

    const result = await handleMessage(world.exclusiveCtx("inv-m1"), config, userMessage("ping"));

    expect(result.outcome).toBe("success");
    const timeline = outbox.timeline(ENTITY);
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);
    // The wake input precedes run_started (module-header convention).
    expect(timeline.slice(5).map((e) => e.type)).toEqual([
      "message",
      "run_started",
      "message",
      "run_finished",
    ]);
    expect(timeline[5]).toMatchObject({
      payload: { role: "user", content: [{ type: "text", text: "ping" }] },
    });
    expect(result.headSeq).toBe(timeline.length - 1);
  });

  it("throws a terminal error for an entity with no live state (never spawned / archived — 0001:T8.1)", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig();
    await expect(
      handleMessage(world.exclusiveCtx("inv-m1"), config, userMessage("hello?")),
    ).rejects.toThrow(/no live state/);
  });

  it("a child_finished delivery records child_finished + system_note events (fan-out consumer side)", async () => {
    const { world, config, outbox } = await spawned();
    const child = agentEntityUrl("default", "default", "child-7");

    await handleMessage(world.exclusiveCtx("inv-cf"), config, {
      kind: "child_finished",
      childId: child,
      outcome: "success",
      result: { answer: 42 },
    });

    const timeline = outbox.timeline(ENTITY);
    const cf = timeline.find((e) => e.type === "child_finished");
    expect(cf).toMatchObject({
      payload: { childId: child, outcome: "success", result: { answer: 42 } },
    });
    const note = timeline.find(
      (e) => e.type === "message" && (e.payload as { role?: string }).role === "system_note",
    );
    expect(note).toBeDefined();
    expect(checkSeqContiguity(timeline).ok).toBe(true);
  });

  it("parallel-spawn fan-out intent: N child_finished deliveries land as N wakes with zero seq collisions", async () => {
    const { world, config, outbox } = await spawned();

    // 0001:D2: a parent spawning N children receives N child_finished messages as
    // N SEPARATE exclusive invocations (single-writer serializes them).
    for (let i = 0; i < 3; i++) {
      await handleMessage(world.exclusiveCtx(`inv-cf-${i}`), config, {
        kind: "child_finished",
        childId: agentEntityUrl("default", "default", `child-${i}`),
        outcome: "success",
      });
    }

    const timeline = outbox.timeline(ENTITY);
    expect(timeline.filter((e) => e.type === "child_finished")).toHaveLength(3);
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);
  });

  it("a subscription_update delivery becomes a system_note wake", async () => {
    const { world, config, outbox } = await spawned();
    const observed = agentEntityUrl("default", "default", "watched-1");

    await handleMessage(world.exclusiveCtx("inv-su"), config, {
      kind: "subscription_update",
      entityId: observed,
      headSeq: 12,
      status: "idle",
    });

    const timeline = outbox.timeline(ENTITY);
    const note = timeline.find(
      (e) => e.type === "message" && (e.payload as { from?: string }).from === observed,
    );
    expect(note).toBeDefined();
  });

  it("arms the debounced subscriber notify after a wake, then fans out on the tick (0001:D2 pub/sub, 0001:T2.3)", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig(); // default debounce > 0
    const subA = agentEntityUrl("default", "default", "watcher-a");
    const subB = agentEntityUrl("default", "default", "watcher-b");
    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, {
      args: {},
      subscribers: [subA, subB],
    });
    world.sent.length = 0;

    await handleMessage(world.exclusiveCtx("inv-m1"), config, userMessage("ping"));

    // Debounced: NO inline subscription_update — instead one coalescing
    // notifyTick self-send is armed (dirty flag set).
    expect(world.sent.filter((s) => s.method === "message")).toHaveLength(0);
    const tick = world.sent.find((s) => s.method === "notifyTick");
    expect(tick).toMatchObject({ service: "agent.default", key: "i-1" });
    const gen = (tick!.parameter as { gen: number }).gen;

    // Firing the tick fans out one subscription_update per subscriber.
    world.sent.length = 0;
    const result = await handleNotifyTick(world.exclusiveCtx("inv-tick"), config, { gen });
    expect(result).toEqual({ notified: 2 });
    const updates = world.sent.filter(
      (s) => (s.parameter as { kind?: string }).kind === "subscription_update",
    );
    expect(updates.map((u) => u.key).sort()).toEqual(["watcher-a", "watcher-b"]);
    expect(updates[0]!.parameter).toMatchObject({ entityId: ENTITY, status: "idle" });
  });

  it("a terminal harness failure records error + run_finished(error) and leaves the entity live", async () => {
    const world = new FakeAgentWorld("i-1");
    const failing: Harness = {
      kind: "stub",
      run: async () => {
        const restate = await import("@restatedev/restate-sdk");
        throw new restate.TerminalError("provider exploded");
      },
    };
    const { config, outbox } = makeConfig();
    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {} });

    const { config: failingConfig } = makeConfig({ harness: failing, outbox });
    const result = await handleMessage(
      world.exclusiveCtx("inv-m1"),
      failingConfig,
      userMessage("boom"),
    );

    expect(result.outcome).toBe("error");
    const timeline = outbox.timeline(ENTITY);
    expect(timeline.find((e) => e.type === "error")).toMatchObject({
      payload: { message: "provider exploded", source: "harness" },
    });
    expect(timeline.at(-1)).toMatchObject({ payload: { outcome: "error" } });
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(world.kv<EntityStatus>(AGENT_KV.status)).toBe("idle"); // still live
    // …and the next wake still works.
    const next = await handleMessage(world.exclusiveCtx("inv-m2"), config, userMessage("again"));
    expect(next.outcome).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// subscribe / unsubscribe (0001:T2.3 pub/sub management) + unsubscribe-stops-notify
// ---------------------------------------------------------------------------

describe("handleSubscribe / handleUnsubscribe", () => {
  async function spawned(): Promise<{ world: FakeAgentWorld; config: AgentObjectConfig }> {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig();
    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {} });
    return { world, config };
  }

  it("subscribe is idempotent and records no timeline event", async () => {
    const { world, config } = await spawned();
    const watcher = agentEntityUrl("default", "default", "watcher-a");

    const first = await handleSubscribe(world.exclusiveCtx("inv-s1"), config, {
      subscriberRef: watcher,
    });
    expect(first).toEqual({ subscribed: true, count: 1 });
    const again = await handleSubscribe(world.exclusiveCtx("inv-s2"), config, {
      subscriberRef: watcher,
    });
    expect(again).toEqual({ subscribed: false, count: 1 });
    expect(world.kv<string[]>(AGENT_KV.subscribers)).toEqual([watcher]);
  });

  it("rejects a non-canonical subscriber url and subscribing to a never-spawned entity", async () => {
    const { world, config } = await spawned();
    await expect(
      handleSubscribe(world.exclusiveCtx("inv-bad"), config, { subscriberRef: "not-a-url" }),
    ).rejects.toThrow(/canonical subscriber url/);

    const fresh = new FakeAgentWorld("i-2");
    await expect(
      handleSubscribe(fresh.exclusiveCtx("inv"), config, {
        subscriberRef: agentEntityUrl("default", "default", "w"),
      }),
    ).rejects.toThrow(/no live state/);
  });

  it("unsubscribe stops that subscriber's notifications (the debounced fan-out skips it)", async () => {
    const { world, config } = await spawned();
    const subA = agentEntityUrl("default", "default", "watcher-a");
    const subB = agentEntityUrl("default", "default", "watcher-b");
    await handleSubscribe(world.exclusiveCtx("inv-sa"), config, { subscriberRef: subA });
    await handleSubscribe(world.exclusiveCtx("inv-sb"), config, { subscriberRef: subB });

    // A wake arms the debounce; the tick fans out to BOTH.
    await handleMessage(world.exclusiveCtx("inv-m1"), config, userMessage("one"));
    let gen = (world.sent.find((s) => s.method === "notifyTick")!.parameter as { gen: number }).gen;
    world.sent.length = 0;
    let res = await handleNotifyTick(world.exclusiveCtx("inv-t1"), config, { gen });
    expect(res).toEqual({ notified: 2 });
    expect(
      world.sent
        .filter((s) => (s.parameter as { kind?: string }).kind === "subscription_update")
        .map((s) => s.key)
        .sort(),
    ).toEqual(["watcher-a", "watcher-b"]);

    // Unsubscribe B, then another wake+tick: only A is notified now.
    const un = await handleUnsubscribe(world.exclusiveCtx("inv-un"), config, { subscriberRef: subB });
    expect(un).toEqual({ unsubscribed: true, count: 1 });
    await handleMessage(world.exclusiveCtx("inv-m2"), config, userMessage("two"));
    gen = (world.sent.find((s) => s.method === "notifyTick")!.parameter as { gen: number }).gen;
    world.sent.length = 0;
    res = await handleNotifyTick(world.exclusiveCtx("inv-t2"), config, { gen });
    expect(res).toEqual({ notified: 1 });
    expect(
      world.sent
        .filter((s) => (s.parameter as { kind?: string }).kind === "subscription_update")
        .map((s) => s.key),
    ).toEqual(["watcher-a"]);
  });
});

// ---------------------------------------------------------------------------
// signal (shared) + the 0001:A4 interrupt seam
// ---------------------------------------------------------------------------

describe("handleSignal (shared handler)", () => {
  it("interrupt on an idle entity delivers nothing", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig();
    const result = await handleSignal(world.sharedCtx(), config, { verb: "interrupt" });
    expect(result).toEqual({ delivered: false, verb: "interrupt", reason: "idle" });
  });

  it("pause/resume/archive are the 0001:T2.5 seam — reported unsupported, never dropped silently", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig();
    for (const verb of ["pause", "resume", "archive"] as const) {
      expect(await handleSignal(world.sharedCtx(), config, { verb })).toEqual({
        delivered: false,
        verb,
        reason: "unsupported",
      });
    }
  });

  it("interrupt reaches a busy exclusive wake: cancels the recorded invocation, aborts the harness, records control + run_finished(interrupted), entity stays live", async () => {
    const world = new FakeAgentWorld("i-1");
    let harnessAborted = false;
    let releaseStarted!: () => void;
    const started = new Promise<void>((res) => (releaseStarted = res));
    // A harness that blocks until the 0001:A4 merged abort signal fires — the
    // exact shape of a long LLM call honoring `input.signal`.
    const blocking: Harness = {
      kind: "stub",
      run: (input) => {
        releaseStarted();
        return new Promise((_, reject) => {
          input.signal.addEventListener(
            "abort",
            () => {
              harnessAborted = true;
              reject(new Error("harness aborted"));
            },
            { once: true },
          );
        });
      },
    };
    const { config, outbox } = makeConfig();
    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {} });

    const { config: blockingConfig } = makeConfig({ harness: blocking, outbox });
    const wake = handleMessage(world.exclusiveCtx("inv-busy"), blockingConfig, userMessage("go"));
    await started; // the exclusive run is now truly in flight

    // The shared handler sees the in-flight invocation id live (SPIKE §a-2)…
    const shared = world.sharedCtx();
    const sig = await handleSignal(shared, blockingConfig, { verb: "interrupt" });
    expect(sig).toEqual({
      delivered: true,
      verb: "interrupt",
      cancelledInvocationId: "inv-busy",
    });

    // …and the wake lands as a NORMAL completion with outcome interrupted.
    const result = await wake;
    expect(result.outcome).toBe("interrupted");
    expect(harnessAborted).toBe(true);

    const timeline = outbox.timeline(ENTITY);
    const tail = timeline.slice(-2);
    expect(tail[0]).toMatchObject({ type: "control", payload: { verb: "interrupt" } });
    expect(tail[1]).toMatchObject({ type: "run_finished", payload: { outcome: "interrupted" } });
    expect(checkSeqContiguity(timeline).ok).toBe(true);

    // Post-interrupt state is consistent and the entity is immediately messageable.
    expect(world.kv(AGENT_KV.currentInvocationId)).toBeNull();
    expect(world.kv<EntityStatus>(AGENT_KV.status)).toBe("idle");
    const next = await handleMessage(world.exclusiveCtx("inv-after"), config, userMessage("still there?"));
    expect(next.outcome).toBe("success");
    expect(checkSeqContiguity(outbox.timeline(ENTITY)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// archiveTick (0001:D7 stub — body is 0001:T8.1)
// ---------------------------------------------------------------------------

describe("handleArchiveTick", () => {
  it("a stale-epoch tick (activity since it was queued) is a pure no-op", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config } = makeConfig();
    await handleSpawn(world.exclusiveCtx("inv-1"), config, { args: {} }); // epoch → 1
    await handleMessage(world.exclusiveCtx("inv-2"), config, userMessage("hi")); // epoch → 2

    const result = await handleArchiveTick(world.exclusiveCtx("inv-tick"), config, { epoch: 1 });
    expect(result).toEqual({ archived: false, reason: "stale-epoch" });
  });

  it("a current-epoch tick on an idle entity archives it (0001:T2.5 applyArchive, trigger idle)", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config, outbox } = makeConfig();
    await handleSpawn(world.exclusiveCtx("inv-1"), config, { args: {} });

    const epoch = world.kv<number>(AGENT_KV.archiveEpoch)!;
    const result = await handleArchiveTick(world.exclusiveCtx("inv-tick"), config, { epoch });
    expect(result).toMatchObject({ archived: true });

    const timeline = outbox.timeline(ENTITY);
    // control(archive) → state_snapshot(pre_archive) → archived, in order.
    expect(timeline.slice(-3).map((e) => e.type)).toEqual([
      "control",
      "state_snapshot",
      "archived",
    ]);
    expect(timeline.at(-3)).toMatchObject({ payload: { verb: "archive" } });
    expect(timeline.at(-2)).toMatchObject({ payload: { reason: "pre_archive" } });
    expect(timeline.at(-1)).toMatchObject({ payload: { reason: "idle" } });
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);
    // K/V fully cleared (0001:D7) — the entity now has no live state.
    expect(world.kv(AGENT_KV.seq)).toBeNull();
    expect(world.kv(AGENT_KV.status)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outbox seam: chunking (0001:R4) + crash-retry (0001:D3)
// ---------------------------------------------------------------------------

describe("projection outbox seam", () => {
  it("a large harness event array is committed across bounded stage+flush chunks (0001:R4/0001:A4)", async () => {
    const world = new FakeAgentWorld("i-1");
    const many = Array.from({ length: 20 }, (_, i): TimelineEventInit => ({
      type: "message",
      ts: new Date().toISOString(),
      payload: {
        id: `bulk-${i}`,
        role: "assistant",
        content: [{ type: "text", text: `chunk ${i}` }],
      },
    }));
    const { config, outbox } = makeConfig({
      harness: createStubHarness({ produce: () => many }),
      outboxChunkSize: 4,
    });

    await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: {} });

    const timeline = outbox.timeline(ENTITY);
    // entity_spawned + spawn-args message + run_started + 20 bulk + run_finished
    expect(timeline).toHaveLength(24);
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    // 20 bulk + run_finished at chunk size 4 ⇒ ≥ 6 flushes for the result
    // alone; assert the chunking actually happened rather than one big write.
    expect(outbox.flushCalls).toBeGreaterThanOrEqual(6);
    expect(world.kv(AGENT_KV.outbox)).toEqual([]);
  });

  it("commitEventsChunked with no events performs no flush", async () => {
    const world = new FakeAgentWorld("i-1");
    const outbox = new InMemoryProjectionOutbox();
    const out = await commitEventsChunked(world.exclusiveCtx("inv"), outbox, ENTITY, []);
    expect(out).toEqual([]);
    expect(outbox.flushCalls).toBe(0);
  });

  it("a pending outbox left by a crashed wake is flushed FIRST on the next invocation (0001:D3 retry, in order)", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config, outbox } = makeConfig();

    // Simulate a crash after staging (seq allocated, K/V outbox populated)
    // but before flush: stage entity_spawned@0 directly, skip the flush.
    const setupCtx = world.exclusiveCtx("inv-crashed");
    await outbox.stage(setupCtx, ENTITY, [
      {
        type: "entity_spawned",
        ts: new Date().toISOString(),
        payload: { entityType: "default", parentId: null },
      },
    ]);
    expect(outbox.timeline(ENTITY)).toHaveLength(0); // never reached the stream
    world.state.set(AGENT_KV.status, "idle");
    world.state.set(AGENT_KV.context, []);

    await handleMessage(world.exclusiveCtx("inv-next"), config, userMessage("resume"));

    const timeline = outbox.timeline(ENTITY);
    expect(timeline[0]).toMatchObject({ type: "entity_spawned", seq: 0 });
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);
    expect(world.kv(AGENT_KV.outbox)).toEqual([]);
  });

  it("the stub stream enforces the C4 producer rules (duplicate = no-op, gap = reject) — 0001:A1 stays a live assertion", async () => {
    const world = new FakeAgentWorld("i-1");
    const outbox = new InMemoryProjectionOutbox();
    const ctx = world.exclusiveCtx("inv");
    const [ev0] = await outbox.stage(ctx, ENTITY, [
      {
        type: "entity_spawned",
        ts: new Date().toISOString(),
        payload: { entityType: "default", parentId: null },
      },
    ]);
    await outbox.flush(ctx, ENTITY);

    // Duplicate append (retry after confirm, pre-trim crash): idempotent no-op.
    world.state.set(AGENT_KV.outbox, [ev0]);
    const dup = await outbox.flush(ctx, ENTITY);
    expect(dup.appended).toBe(0);
    expect(dup.headSeq).toBe(0);

    // Gapped append: rejected (the producer protocol would refuse it).
    const gapped = { ...ev0!, seq: 5 };
    world.state.set(AGENT_KV.outbox, [gapped]);
    await expect(outbox.flush(ctx, ENTITY)).rejects.toThrow(/seq gap/);
  });
});

// ---------------------------------------------------------------------------
// Template wiring (0001:T6.1 seam)
// ---------------------------------------------------------------------------

describe("createAgentObject (template)", () => {
  it("realizes the 0001:A3 naming: service `agent.<type>`", () => {
    const { config } = makeConfig();
    const obj = createAgentObject(config);
    expect(obj.name).toBe("agent.default");
    expect(agentServiceName("researcher")).toBe("agent.researcher");
  });

  it("rejects agent types outside the addressing charset", () => {
    expect(() => agentServiceName("Bad.Type")).toThrow(/invalid agent type/);
    expect(() => agentServiceName("")).toThrow(/invalid agent type/);
    const { config } = makeConfig();
    expect(() => createAgentObject({ ...config, entityType: "UPPER" })).toThrow(
      /invalid agent type/,
    );
  });

  it("validateSpawnArgs (the defineAgent spawnSchema hook) gates spawn", async () => {
    const world = new FakeAgentWorld("i-1");
    const { config, outbox } = makeConfig({
      validateSpawnArgs: () => {
        throw new Error("spawn args rejected");
      },
    });
    await expect(
      handleSpawn(world.exclusiveCtx("inv"), config, { args: { bad: true } }),
    ).rejects.toThrow("spawn args rejected");
    expect(outbox.timeline(ENTITY)).toHaveLength(0); // nothing committed
  });
});
