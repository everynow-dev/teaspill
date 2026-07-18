/**
 * 0001:T8.1 — archival persistence, resurrection, idle auto-archive, and the onWake
 * loop wiring. Unit tests against the same in-memory fakes as agent.test.ts /
 * control.test.ts (structural `AgentRuntimeCtx`, `InMemoryProjectionOutbox`,
 * `InMemoryArchiveCatalog`).
 *
 * Live-Restate behaviors (real single-writer serialization, `ctx.run` replay,
 * delayed-send timing) are conformance-kit items (0001:T6.3/0001:T9.1). Single-writer is
 * MODELED by running successive invocations sequentially on one shared K/V — the
 * exact ordering Restate guarantees per key — which is what makes resurrection
 * race-safe here (the first invocation rehydrates; the second sees live state).
 */

import { describe, expect, it } from "vitest";
import {
  checkSeqContiguity,
  checkTimelineInvariants,
  type RunOutcome,
  type TimelineEvent,
} from "@teaspill/schema";
import * as restate from "@restatedev/restate-sdk";
import type { Harness } from "@teaspill/harness-native";
import { AGENT_KV, type AgentRuntimeCtx, type EntityStatus } from "./agent-runtime.js";
import {
  InMemoryArchiveCatalog,
  InMemoryProjectionOutbox,
  createSendNotifier,
  createStubHarness,
} from "./agent-seams.js";
import {
  agentEntityUrl,
  handleArchiveTick,
  handleMessage,
  handleSpawn,
  scheduleArchiveTick,
  type AgentMessageInput,
  type AgentObjectConfig,
  type OnWakeContext,
  type OnWakeHandler,
} from "./agent.js";
import { handleArchive } from "./control.js";
import { OUTBOX_KV } from "./projection-outbox.js";
import {
  boundArchiveSnapshotState,
  serializedBytes,
  ArchiveSnapshotTooLargeError,
  type ArchiveSnapshotState,
} from "./archive-snapshot.js";

// ---------------------------------------------------------------------------
// Fakes (mirror agent.test.ts / control.test.ts)
// ---------------------------------------------------------------------------

interface SentCall {
  service: string;
  method: string;
  key?: string;
  parameter: unknown;
  delay?: number;
}

class FakeWorld {
  readonly state = new Map<string, unknown>();
  readonly sent: SentCall[] = [];
  constructor(readonly key: string) {}
  ctx(invocationId: string): FakeCtx {
    return new FakeCtx(this, invocationId);
  }
  kv<T>(name: string): T | null {
    return this.state.has(name) ? (this.state.get(name) as T) : null;
  }
}

class FakeCtx implements AgentRuntimeCtx {
  readonly key: string;
  readonly runAbortSignal = new AbortController().signal;
  constructor(
    private readonly world: FakeWorld,
    readonly invocationId: string,
  ) {
    this.key = world.key;
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
    return work;
  }
  armInterruptAbort(): void {}
}

const ENTITY = agentEntityUrl("default", "default", "i-1");
const userMessage = (text: string): AgentMessageInput => ({ content: [{ type: "text", text }] });

function makeConfig(
  overrides: Partial<AgentObjectConfig> = {},
  opts: { noArchiveCatalog?: boolean } = {},
): {
  config: AgentObjectConfig;
  outbox: InMemoryProjectionOutbox;
  archiveCatalog: InMemoryArchiveCatalog;
} {
  const outbox = (overrides.outbox as InMemoryProjectionOutbox) ?? new InMemoryProjectionOutbox();
  const archiveCatalog =
    (overrides.archiveCatalog as InMemoryArchiveCatalog) ?? new InMemoryArchiveCatalog();
  const config: AgentObjectConfig = {
    entityType: "default",
    harness: createStubHarness(),
    outbox,
    notifier: createSendNotifier(),
    ...(opts.noArchiveCatalog ? {} : { archiveCatalog }),
    ...overrides,
  };
  return { config, outbox, archiveCatalog };
}

async function spawnThenArchive(overrides: Partial<AgentObjectConfig> = {}): Promise<{
  world: FakeWorld;
  config: AgentObjectConfig;
  outbox: InMemoryProjectionOutbox;
  archiveCatalog: InMemoryArchiveCatalog;
  archivedHeadSeq: number;
}> {
  const world = new FakeWorld("i-1");
  const { config, outbox, archiveCatalog } = makeConfig(overrides);
  await handleSpawn(world.ctx("inv-spawn"), config, { args: { task: "hi" } });
  const res = await handleArchive(world.ctx("inv-archive"), config, { reason: "done" });
  if (!res.archived) throw new Error("expected archive");
  // The fresh spawn above consulted the catalog once (resurrect-detection on a
  // never-before-seen key, returning null). Reset so tests count only the
  // post-archive resurrection loads.
  archiveCatalog.loadCalls = 0;
  return { world, config, outbox, archiveCatalog, archivedHeadSeq: res.headSeq };
}

// ===========================================================================
// Archive persistence + size bound
// ===========================================================================

describe("archive persists archived_snapshot to the catalog (0001:D7)", () => {
  it("persists the bounded snapshot + head_seq; clears live K/V", async () => {
    const { world, outbox, archiveCatalog, archivedHeadSeq } = await spawnThenArchive();

    expect(archiveCatalog.persistCalls).toBe(1);
    const row = archiveCatalog.rows.get(ENTITY);
    expect(row).toBeDefined();
    expect(row!.headSeq).toBe(archivedHeadSeq);
    const snapshot = row!.snapshot as unknown as ArchiveSnapshotState;
    // The snapshot is the bounded context + pointers (0001:D7), NOT the timeline.
    expect(Array.isArray(snapshot.context)).toBe(true);
    expect(snapshot.usage).toBeDefined();
    expect(snapshot.parentRef).toBeNull();

    // Live K/V is cleared (0001:D7) — the entity now has no live state.
    expect(world.kv(AGENT_KV.seq)).toBeNull();
    expect(world.kv(AGENT_KV.status)).toBeNull();
    expect(world.kv(OUTBOX_KV.confirmedSeq)).toBeNull();

    // The stream still carries the terminal archived event (history survives).
    const timeline = outbox.timeline(ENTITY);
    expect(timeline.at(-1)!.type).toBe("archived");
    expect(checkSeqContiguity(timeline).ok).toBe(true);
  });

  it("without an archiveCatalog, archive writes the stream snapshot but persists nothing", async () => {
    const world = new FakeWorld("i-1");
    const { config, outbox } = makeConfig({}, { noArchiveCatalog: true });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    const res = await handleArchive(world.ctx("inv-archive"), config, {});
    expect(res.archived).toBe(true);
    // stream snapshot still written
    expect(outbox.timeline(ENTITY).some((e) => e.type === "state_snapshot")).toBe(true);
  });
});

describe("boundArchiveSnapshotState — write-time size bound (0001:D7/0001:R4)", () => {
  const base: ArchiveSnapshotState = {
    context: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    workspaceRef: null,
    parentRef: null,
    subscribers: [],
    harness: null,
  };

  it("returns the state unchanged when it fits", () => {
    const out = boundArchiveSnapshotState(base, 10_000);
    expect(out).toBe(base);
    expect(out.contextTruncated).toBeUndefined();
  });

  it("drops the OLDEST context events until it fits, flagging the truncation", () => {
    const bigEvent = (i: number): TimelineEvent =>
      ({
        v: 1,
        entityId: ENTITY,
        seq: i,
        ts: "2026-07-17T00:00:00.000Z",
        type: "message",
        payload: { id: `m-${i}`, role: "assistant", content: [{ type: "text", text: "x".repeat(200) }] },
      }) as unknown as TimelineEvent;
    const state: ArchiveSnapshotState = { ...base, context: Array.from({ length: 10 }, (_, i) => bigEvent(i)) };

    const bounded = boundArchiveSnapshotState(state, 800);
    expect(bounded.contextTruncated).toBe(true);
    expect(bounded.droppedContextEvents).toBeGreaterThan(0);
    expect(serializedBytes(bounded)).toBeLessThanOrEqual(800);
    // Keeps the NEWEST events (drops from the front).
    const keptSeqs = bounded.context.map((e) => e.seq);
    expect(keptSeqs[keptSeqs.length - 1]).toBe(9);
  });

  it("throws when even an empty context is over the bound (non-context state too big)", () => {
    const state: ArchiveSnapshotState = { ...base, harness: { blob: "y".repeat(2000) } };
    expect(() => boundArchiveSnapshotState(state, 500)).toThrow(ArchiveSnapshotTooLargeError);
  });

  it("applyArchive honors config.archiveSnapshotMaxBytes", async () => {
    const world = new FakeWorld("i-1");
    const { config, archiveCatalog } = makeConfig({ archiveSnapshotMaxBytes: 700 });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    // Seed a large bounded context, then archive.
    world.state.set(
      AGENT_KV.context,
      Array.from({ length: 8 }, (_, i) => ({
        v: 1,
        entityId: ENTITY,
        seq: i,
        ts: "2026-07-17T00:00:00.000Z",
        type: "message",
        payload: { id: `m-${i}`, role: "assistant", content: [{ type: "text", text: "z".repeat(200) }] },
      })),
    );
    await handleArchive(world.ctx("inv-archive"), config, {});
    const snapshot = archiveCatalog.rows.get(ENTITY)!.snapshot as unknown as ArchiveSnapshotState;
    expect(serializedBytes(snapshot)).toBeLessThanOrEqual(700);
    expect(snapshot.contextTruncated).toBe(true);
  });
});

// ===========================================================================
// Resurrection
// ===========================================================================

describe("resurrection on a message to an archived entity (0001:D7)", () => {
  it("rehydrates from the catalog snapshot, continues seq from head_seq, stays contiguous", async () => {
    const { world, config, outbox, archiveCatalog, archivedHeadSeq } = await spawnThenArchive();
    expect(world.kv(AGENT_KV.seq)).toBeNull(); // archived-and-cleared

    const res = await handleMessage(world.ctx("inv-wake"), config, userMessage("you awake?"));
    expect(res.outcome).toBe("success");
    expect(archiveCatalog.loadCalls).toBe(1);

    // Seq CONTINUED from head_seq (0001:A5): the first resurrected event is head+1.
    const timeline = outbox.timeline(ENTITY);
    const firstAfterArchive = timeline.find((e) => e.seq === archivedHeadSeq + 1);
    expect(firstAfterArchive).toBeDefined();
    expect(firstAfterArchive!.type).toBe("message");
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);

    // Back to active during the wake, idle after.
    expect(world.kv<EntityStatus>(AGENT_KV.status)).toBe("idle");
    // The resurrected context carries the pre-archive context forward.
    const context = world.kv<TimelineEvent[]>(AGENT_KV.context) ?? [];
    expect(context.length).toBeGreaterThan(0);
  });

  it("is race-safe: a SECOND message sees live state and does not re-rehydrate", async () => {
    const { world, config, archiveCatalog } = await spawnThenArchive();

    // Single-writer: the two invocations run in sequence on one K/V.
    await handleMessage(world.ctx("inv-wake-1"), config, userMessage("first"));
    await handleMessage(world.ctx("inv-wake-2"), config, userMessage("second"));

    // Only the FIRST invocation loaded the catalog; the second saw seq !== null.
    expect(archiveCatalog.loadCalls).toBe(1);
    expect(world.kv<EntityStatus>(AGENT_KV.status)).toBe("idle");
  });

  it("a spawn to an archived key resurrects and reattaches (no re-init over the timeline)", async () => {
    const { world, config, outbox, archiveCatalog, archivedHeadSeq } = await spawnThenArchive();
    const before = outbox.timeline(ENTITY).length;

    const res = await handleSpawn(world.ctx("inv-respawn"), config, { args: { task: "again" } });
    expect(res.created).toBe(false); // reattach, not a fresh entity
    expect(res.headSeq).toBe(archivedHeadSeq);
    expect(archiveCatalog.loadCalls).toBe(1);
    // No new events (no wake) and NO second entity_spawned@0 collision.
    expect(outbox.timeline(ENTITY).length).toBe(before);
    expect(world.kv<EntityStatus>(AGENT_KV.status)).toBe("idle");
    // Now live again: a message wakes and continues the seq.
    const wake = await handleMessage(world.ctx("inv-wake"), config, userMessage("hi"));
    expect(wake.outcome).toBe("success");
    expect(checkSeqContiguity(outbox.timeline(ENTITY)).ok).toBe(true);
  });

  it("a message to a never-spawned entity with no snapshot still fails loudly", async () => {
    const world = new FakeWorld("i-1");
    const { config } = makeConfig(); // archiveCatalog present but empty
    await expect(handleMessage(world.ctx("inv-x"), config, userMessage("hi"))).rejects.toThrow(
      restate.TerminalError,
    );
  });

  it("without an archiveCatalog, an archived entity cannot resurrect (pre-0001:T8.1 behavior)", async () => {
    const world = new FakeWorld("i-1");
    const { config } = makeConfig({}, { noArchiveCatalog: true });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    await handleArchive(world.ctx("inv-archive"), config, {});
    await expect(handleMessage(world.ctx("inv-wake"), config, userMessage("hi"))).rejects.toThrow(
      /no live state/,
    );
  });

  it("resurrects via the idle-auto-archive path too (integration of the two)", async () => {
    const world = new FakeWorld("i-1");
    const { config, outbox } = makeConfig({ idleArchiveDelayMs: 60_000 });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    // A live-epoch idle tick archives it.
    const epoch = world.kv<number>(AGENT_KV.archiveEpoch)!;
    const tick = await handleArchiveTick(world.ctx("inv-tick"), config, { epoch });
    expect(tick).toMatchObject({ archived: true });
    expect(world.kv(AGENT_KV.seq)).toBeNull();

    // A later message resurrects — no dead-letter, no stranding.
    const res = await handleMessage(world.ctx("inv-wake"), config, userMessage("back"));
    expect(res.outcome).toBe("success");
    expect(checkSeqContiguity(outbox.timeline(ENTITY)).ok).toBe(true);
  });
});

// ===========================================================================
// Idle auto-archive: timer scheduling + reset on activity (0001:D7)
// ===========================================================================

describe("idle auto-archive timer (0001:D7)", () => {
  it("every wake arms a fresh-epoch delayed archiveTick self-send (reset-on-activity)", async () => {
    const world = new FakeWorld("i-1");
    const { config } = makeConfig({ idleArchiveDelayMs: 30_000 });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    const epochAfterSpawn = world.kv<number>(AGENT_KV.archiveEpoch)!;

    world.sent.length = 0;
    await handleMessage(world.ctx("inv-msg"), config, userMessage("ping"));
    const epochAfterMsg = world.kv<number>(AGENT_KV.archiveEpoch)!;

    // Activity bumped the epoch — any tick queued under the old epoch is now stale.
    expect(epochAfterMsg).toBeGreaterThan(epochAfterSpawn);
    const tick = world.sent.find((s) => s.method === "archiveTick");
    expect(tick).toMatchObject({ method: "archiveTick", delay: 30_000, parameter: { epoch: epochAfterMsg } });

    // The stale tick is a pure no-op (the reset works).
    const stale = await handleArchiveTick(world.ctx("inv-stale"), config, { epoch: epochAfterSpawn });
    expect(stale).toEqual({ archived: false, reason: "stale-epoch" });
  });

  it("idleArchiveDelayMs = 0 disables the timer (the config knob)", async () => {
    const world = new FakeWorld("i-1");
    const { config } = makeConfig({ idleArchiveDelayMs: 0 });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    expect(world.sent.some((s) => s.method === "archiveTick")).toBe(false);
  });

  it("scheduleArchiveTick bumps the epoch and emits the delayed self-send", async () => {
    const world = new FakeWorld("i-1");
    const { config } = makeConfig({ idleArchiveDelayMs: 12_345 });
    world.state.set(AGENT_KV.archiveEpoch, 5);
    await scheduleArchiveTick(world.ctx("inv-x"), config);
    expect(world.kv(AGENT_KV.archiveEpoch)).toBe(6);
    expect(world.sent.at(-1)).toMatchObject({ method: "archiveTick", delay: 12_345, parameter: { epoch: 6 } });
  });
});

// ===========================================================================
// onWake wiring (0001:T6.1/0001:T6.3 carry-forward)
// ===========================================================================

describe("onWake loop wiring (deterministic per-wake logic)", () => {
  // A stub harness that marks whether it ran, so onWake-only can prove it did NOT.
  function markerHarness(): { harness: Harness; ran: () => boolean } {
    let ran = false;
    const harness = createStubHarness({
      produce: () => {
        ran = true;
        return [
          {
            type: "message",
            ts: "2026-07-17T00:00:00.000Z",
            payload: { id: "harness-out", role: "assistant", content: [{ type: "text", text: "LLM ran" }] },
          },
        ];
      },
    });
    return { harness, ran: () => ran };
  }

  it("onWake-only: HANDLES the wake fully; the harness does NOT run", async () => {
    const world = new FakeWorld("i-1");
    const { harness, ran } = markerHarness();
    const onWake: OnWakeHandler = async (w: OnWakeContext) => {
      const now = await w.now();
      await w.emit([
        {
          type: "message",
          ts: new Date(now).toISOString(),
          payload: { id: "onwake-out", role: "system_note", content: [{ type: "text", text: "handled deterministically" }] },
        },
      ]);
      return { handled: true };
    };
    const { config, outbox } = makeConfig({ harness, onWake });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    world.sent.length = 0;

    const res = await handleMessage(world.ctx("inv-wake"), config, userMessage("do the thing"));
    expect(res.outcome).toBe("success");
    expect(ran()).toBe(false); // harness never ran (onWake-only)

    const timeline = outbox.timeline(ENTITY);
    const texts = timeline
      .filter((e) => e.type === "message")
      .map((e) => JSON.stringify(e.payload));
    expect(texts.some((t) => t.includes("handled deterministically"))).toBe(true);
    expect(texts.some((t) => t.includes("LLM ran"))).toBe(false);
    // Well-formed run brackets around the onWake events.
    expect(timeline.some((e) => e.type === "run_started")).toBe(true);
    expect(timeline.at(-1)!.type).toBe("run_finished");
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);
  });

  it("onWake-then-harness: HANDS OFF; onWake events precede the harness output", async () => {
    const world = new FakeWorld("i-1");
    const { harness, ran } = markerHarness();
    const onWake: OnWakeHandler = async (w: OnWakeContext) => {
      await w.emit([
        {
          type: "message",
          ts: "2026-07-17T00:00:00.000Z",
          payload: { id: "onwake-pre", role: "system_note", content: [{ type: "text", text: "pre-harness note" }] },
        },
      ]);
      // falsy return ⇒ hand off to the harness
    };
    const { config, outbox } = makeConfig({ harness, onWake });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });

    const res = await handleMessage(world.ctx("inv-wake"), config, userMessage("go"));
    expect(res.outcome).toBe("success");
    expect(ran()).toBe(true); // harness DID run

    const timeline = outbox.timeline(ENTITY);
    const noteIdx = timeline.findIndex((e) => JSON.stringify(e.payload).includes("pre-harness note"));
    const llmIdx = timeline.findIndex((e) => JSON.stringify(e.payload).includes("LLM ran"));
    expect(noteIdx).toBeGreaterThan(-1);
    expect(llmIdx).toBeGreaterThan(noteIdx); // onWake event precedes harness output
    expect(timeline.at(-1)!.type).toBe("run_finished");
    expect(checkSeqContiguity(timeline).ok).toBe(true);
    expect(checkTimelineInvariants(timeline)).toEqual([]);
  });

  it("onWake can send to another agent (deterministic coordination)", async () => {
    const world = new FakeWorld("i-1");
    const target = agentEntityUrl("default", "default", "peer");
    const onWake: OnWakeHandler = (w: OnWakeContext) => {
      w.send(target, { content: [{ type: "text", text: "hello peer" }] });
      return { handled: true };
    };
    const { config } = makeConfig({ onWake });
    await handleSpawn(world.ctx("inv-spawn"), config, { args: {} });
    world.sent.length = 0;
    const res: { outcome?: RunOutcome } = await handleMessage(world.ctx("inv-wake"), config, userMessage("relay"));
    expect(res.outcome).toBe("success");
    expect(world.sent.some((s) => s.method === "message" && s.key === "peer")).toBe(true);
  });
});
