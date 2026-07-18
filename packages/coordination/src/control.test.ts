/**
 * 0001:T2.5 control API — unit tests against in-memory fakes (the agent.test.ts /
 * cron.test.ts pattern: the same handler functions the real `restate.object`
 * wiring calls, exercised on a structural fake context).
 *
 * Covers the four verbs on 0001:T2.1's seam: `interrupt` (shared front door aborts
 * an in-flight run, records control + run_finished(interrupted), entity stays
 * messageable), `pause`/`resume` (queue-without-processing then drain), and
 * `archive` (control + pre-archive snapshot + terminal archived + K/V clear).
 * Plus the 0001:T2.6 steerbox wake-start drain wired into `runWake`.
 *
 * Live-Restate behaviors (real `ctx.cancel` delivery, `explicitCancellation`
 * semantics, shared-vs-exclusive scheduling, self-send re-enqueue ordering)
 * are conformance-kit items (0001:T6.3/0001:T9.1), not covered here.
 */

import { describe, expect, it } from "vitest";
import { checkSeqContiguity, checkTimelineInvariants } from "@teaspill/schema";
import type { Harness } from "@teaspill/harness-native";
import type { SteerMessage, SteerSource } from "@teaspill/harness-native";
import {
  AGENT_KV,
  AgentInterruptedError,
  type AgentRuntimeCtx,
  type AgentSharedRuntimeCtx,
  type EntityStatus,
} from "./agent-runtime.js";
import { InMemoryProjectionOutbox, createSendNotifier, createStubHarness } from "./agent-seams.js";
import {
  agentEntityUrl,
  handleMessage,
  handleSpawn,
  type AgentMessageInput,
  type AgentObjectConfig,
} from "./agent.js";
import { handleArchive, handleInterrupt, handlePause, handleResume } from "./control.js";

// ---------------------------------------------------------------------------
// Fakes (mirrors agent.test.ts's FakeAgentWorld)
// ---------------------------------------------------------------------------

interface SentCall {
  service: string;
  method: string;
  key?: string;
  parameter: unknown;
  delay?: number;
}

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

  triggerInterrupt(): void {
    if (this.interruptReject) this.interruptReject(new AgentInterruptedError());
    else this.interruptedEarly = true;
    this.abort.abort();
  }
}

// ---------------------------------------------------------------------------
// Helpers
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
const userMessage = (text: string): AgentMessageInput => ({ content: [{ type: "text", text }] });

async function spawned(overrides: Partial<AgentObjectConfig> = {}): Promise<{
  world: FakeAgentWorld;
  config: AgentObjectConfig;
  outbox: InMemoryProjectionOutbox;
}> {
  const world = new FakeAgentWorld("i-1");
  const { config, outbox } = makeConfig(overrides);
  await handleSpawn(world.exclusiveCtx("inv-spawn"), config, { args: { task: "hi" } });
  return { world, config, outbox };
}

// ===========================================================================
// interrupt
// ===========================================================================

describe("handleInterrupt (public shared front door)", () => {
  it("interrupt on an idle entity delivers nothing", async () => {
    const { world, config } = await spawned();
    const res = await handleInterrupt(world.sharedCtx(), config, { reason: "user asked" });
    expect(res).toEqual({ verb: "interrupt", delivered: false, reason: "idle" });
  });

  it("aborts an in-flight harness run, records control + run_finished(interrupted), entity stays messageable", async () => {
    const world = new FakeAgentWorld("i-1");
    let harnessAborted = false;
    let releaseStarted!: () => void;
    const started = new Promise<void>((res) => (releaseStarted = res));
    // A long LLM-shaped harness that blocks until the 0001:A4 merged abort fires.
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
    await started; // the exclusive run is truly in flight

    const sig = await handleInterrupt(world.sharedCtx(), blockingConfig, { reason: "stop" });
    expect(sig).toEqual({
      verb: "interrupt",
      delivered: true,
      cancelledInvocationId: "inv-busy",
    });

    const result = await wake;
    expect(result.outcome).toBe("interrupted");
    expect(harnessAborted).toBe(true);

    const timeline = outbox.timeline(ENTITY);
    const tail = timeline.slice(-2);
    expect(tail[0]).toMatchObject({ type: "control", payload: { verb: "interrupt" } });
    expect(tail[1]).toMatchObject({ type: "run_finished", payload: { outcome: "interrupted" } });
    expect(checkSeqContiguity(timeline).ok).toBe(true);

    // Consistent + immediately messageable.
    expect(world.kv(AGENT_KV.currentInvocationId)).toBeNull();
    expect(world.kv<EntityStatus>(AGENT_KV.status)).toBe("idle");
    const next = await handleMessage(world.exclusiveCtx("inv-after"), config, userMessage("still there?"));
    expect(next.outcome).toBe("success");
    expect(checkSeqContiguity(outbox.timeline(ENTITY)).ok).toBe(true);
  });
});

// ===========================================================================
// pause / resume
// ===========================================================================

describe("handlePause / handleResume", () => {
  it("pause records control(pause), sets the flag (not the status enum), and re-arms the archive timer", async () => {
    const { world, config, outbox } = await spawned({ idleArchiveDelayMs: 60_000 });
    world.sent.length = 0;

    const res = await handlePause(world.exclusiveCtx("inv-p"), config, { reason: "maintenance" });
    expect(res).toMatchObject({ verb: "pause", applied: true });

    expect(world.kv<boolean>(AGENT_KV.paused)).toBe(true);
    // pause is a runtime flag, NOT a catalog status change (stays idle).
    expect(world.kv<EntityStatus>(AGENT_KV.status)).toBe("idle");
    expect(outbox.timeline(ENTITY).at(-1)).toMatchObject({
      type: "control",
      payload: { verb: "pause", reason: "maintenance" },
    });
    expect(world.sent.find((s) => s.method === "archiveTick")).toBeDefined();
  });

  it("a paused entity QUEUES messages without processing them (no harness run, no events)", async () => {
    const { world, config, outbox } = await spawned();
    await handlePause(world.exclusiveCtx("inv-p"), config, {});
    const lenAfterPause = outbox.timeline(ENTITY).length;

    const r1 = await handleMessage(world.exclusiveCtx("inv-m1"), config, userMessage("one"));
    const r2 = await handleMessage(world.exclusiveCtx("inv-m2"), config, userMessage("two"));

    expect(r1.queued).toBe(true);
    expect(r1.outcome).toBeUndefined();
    expect(r2.queued).toBe(true);
    // No new timeline events while paused (harness never ran).
    expect(outbox.timeline(ENTITY)).toHaveLength(lenAfterPause);
    // Both are held in the mailbox, in order.
    const mailbox = world.kv<AgentMessageInput[]>(AGENT_KV.pausedMailbox)!;
    expect(mailbox).toHaveLength(2);
    expect((mailbox[0] as { content: { text: string }[] }).content[0]!.text).toBe("one");
    expect((mailbox[1] as { content: { text: string }[] }).content[0]!.text).toBe("two");
  });

  it("resume clears the flag, records control(resume), and re-enqueues the mailbox as message self-sends in order", async () => {
    const { world, config } = await spawned();
    await handlePause(world.exclusiveCtx("inv-p"), config, {});
    await handleMessage(world.exclusiveCtx("inv-m1"), config, userMessage("one"));
    await handleMessage(world.exclusiveCtx("inv-m2"), config, userMessage("two"));
    world.sent.length = 0;

    const res = await handleResume(world.exclusiveCtx("inv-r"), config, {});
    expect(res).toMatchObject({ verb: "resume", applied: true, drained: 2 });

    expect(world.kv(AGENT_KV.paused)).toBeNull();
    expect(world.kv(AGENT_KV.pausedMailbox)).toBeNull();

    const reenqueued = world.sent.filter((s) => s.method === "message");
    expect(reenqueued).toHaveLength(2);
    expect(reenqueued.map((s) => (s.parameter as { content: { text: string }[] }).content[0]!.text)).toEqual([
      "one",
      "two",
    ]);
    expect(reenqueued.every((s) => s.service === "agent.default" && s.key === "i-1")).toBe(true);
  });

  it("pause/resume are no-ops on the wrong state (not-paused resume, double pause, no live state)", async () => {
    const { world, config } = await spawned();
    expect(await handleResume(world.exclusiveCtx("inv-r0"), config, {})).toEqual({
      verb: "resume",
      applied: false,
      reason: "not-paused",
    });
    await handlePause(world.exclusiveCtx("inv-p1"), config, {});
    expect(await handlePause(world.exclusiveCtx("inv-p2"), config, {})).toEqual({
      verb: "pause",
      applied: false,
      reason: "already-paused",
    });

    const fresh = new FakeAgentWorld("i-2");
    expect(await handlePause(fresh.exclusiveCtx("inv"), config, {})).toEqual({
      verb: "pause",
      applied: false,
      reason: "no-live-state",
    });
  });

  it("a resumed entity processes a fresh message normally again", async () => {
    const { world, config, outbox } = await spawned();
    await handlePause(world.exclusiveCtx("inv-p"), config, {});
    await handleResume(world.exclusiveCtx("inv-r"), config, {});

    const res = await handleMessage(world.exclusiveCtx("inv-m"), config, userMessage("now run"));
    expect(res.outcome).toBe("success");
    expect(res.queued).toBeUndefined();
    expect(checkSeqContiguity(outbox.timeline(ENTITY)).ok).toBe(true);
  });
});

// ===========================================================================
// archive
// ===========================================================================

describe("handleArchive", () => {
  it("records control(archive) + state_snapshot(pre_archive) + terminal archived, transitions, and clears K/V", async () => {
    const { world, config, outbox } = await spawned();

    const res = await handleArchive(world.exclusiveCtx("inv-a"), config, { reason: "done" });
    expect(res).toMatchObject({ verb: "archive", archived: true });

    const timeline = outbox.timeline(ENTITY);
    expect(timeline.slice(-3).map((e) => e.type)).toEqual([
      "control",
      "state_snapshot",
      "archived",
    ]);
    const control = timeline.at(-3)!;
    const snapshot = timeline.at(-2)!;
    const archived = timeline.at(-1)!;
    expect(control).toMatchObject({ payload: { verb: "archive", reason: "done" } });
    expect(snapshot).toMatchObject({ payload: { reason: "pre_archive" } });
    // archived event points at the snapshot's seq (trigger = requested for the verb).
    expect(archived).toMatchObject({ payload: { reason: "requested", snapshotSeq: snapshot.seq } });
    expect((res as { snapshotSeq: number }).snapshotSeq).toBe(snapshot.seq);

    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);

    // The pre-archive snapshot state carries the bounded context (resurrection payload, 0001:T8.1).
    const snapState = (snapshot.payload as unknown as { state: { context: unknown[] } }).state;
    expect(Array.isArray(snapState.context)).toBe(true);

    // ALL K/V cleared — the entity now has no live state.
    expect(world.kv(AGENT_KV.seq)).toBeNull();
    expect(world.kv(AGENT_KV.status)).toBeNull();
    expect(world.kv(AGENT_KV.context)).toBeNull();
    expect(world.kv(AGENT_KV.outbox)).toBeNull();
  });

  it("a message to an archived (cleared) entity fails with no-live-state (resurrection is 0001:T8.1)", async () => {
    const { world, config } = await spawned();
    await handleArchive(world.exclusiveCtx("inv-a"), config, {});
    await expect(
      handleMessage(world.exclusiveCtx("inv-m"), config, userMessage("hello?")),
    ).rejects.toThrow(/no live state/);
  });

  it("archive is a no-op on an entity with no live state", async () => {
    const fresh = new FakeAgentWorld("i-2");
    const { config } = makeConfig();
    expect(await handleArchive(fresh.exclusiveCtx("inv"), config, {})).toEqual({
      verb: "archive",
      archived: false,
      reason: "no-live-state",
    });
  });
});

// ===========================================================================
// steerbox wake-start drain (0001:T2.6 no-loss contract, wired into runWake)
// ===========================================================================

describe("steerbox wake-start drain (runWake wire-in)", () => {
  /** A fake SteerSource that yields its queued messages once, then nothing. */
  function fakeSteerSource(messages: SteerMessage[]): SteerSource {
    let drained = false;
    return {
      async drain(): Promise<SteerMessage[]> {
        if (drained) return [];
        drained = true;
        return messages;
      },
    };
  }

  it("prepends drained steer messages ahead of the wake's own input (no-loss contract)", async () => {
    const steers: SteerMessage[] = [
      { id: "s-0", ts: new Date().toISOString(), content: [{ type: "text", text: "steer A" }] },
      { id: "s-1", ts: new Date().toISOString(), content: [{ type: "text", text: "steer B" }], from: "someone" },
    ];
    // Spawn with an EMPTY steer source (drain is unconditional every wake, so a
    // draining source at spawn would consume the steers there); then run the
    // message wake with the draining source over the SAME outbox.
    const world = new FakeAgentWorld("i-1");
    const { config: spawnConfig, outbox } = makeConfig();
    await handleSpawn(world.exclusiveCtx("inv-spawn"), spawnConfig, { args: {} });
    const beforeLen = outbox.timeline(ENTITY).length;

    const { config } = makeConfig({ steerSource: fakeSteerSource(steers), outbox });
    await handleMessage(world.exclusiveCtx("inv-m"), config, userMessage("real input"));

    const wakeEvents = outbox.timeline(ENTITY).slice(beforeLen);
    // steer A, steer B (prepended), then the wake's own "real input" message, then run_started …
    const messages = wakeEvents.filter((e) => e.type === "message");
    expect(messages.slice(0, 3).map((m) => (m.payload as { content: { text: string }[] }).content[0]!.text)).toEqual([
      "steer A",
      "steer B",
      "real input",
    ]);
    // run_started comes AFTER all three prepended/own inputs.
    const firstRunStarted = wakeEvents.findIndex((e) => e.type === "run_started");
    expect(wakeEvents.slice(0, firstRunStarted).every((e) => e.type === "message")).toBe(true);
    expect(checkSeqContiguity(outbox.timeline(ENTITY)).ok).toBe(true);
  });
});
