import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  checkSeqContiguity,
  checkTimelineInvariants,
  finalizeEvent,
  isTimelineEvent,
  parseTimelineEvent,
  parseTimelineEventJson,
  safeParseTimelineEvent,
  timelineEventSchema,
  type EventType,
  type TimelineEvent,
  type TimelineEventInit,
} from "./events.js";

const ENTITY = "/t/default/a/researcher/01jz00000000000000000000000";
const TS = "2026-07-17T12:00:00.000Z";

function env(seq: number, type: EventType, payload: unknown): unknown {
  return { v: 1, entityId: ENTITY, seq, ts: TS, type, payload };
}

/**
 * One valid fixture per event type — the exhaustiveness backbone. A new event
 * type added to the union without a fixture here fails the coverage test.
 */
const FIXTURES: Record<EventType, unknown> = {
  entity_spawned: env(0, "entity_spawned", {
    entityType: "researcher",
    parentId: null,
    spawnArgs: { goal: "dig" },
    workspaceRef: "default/a-researcher-01jz00000000000000000000000",
  }),
  run_started: env(1, "run_started", {
    runId: "run-1",
    wake: { source: "spawn" },
    harness: "native",
    model: "claude-fable-5",
  }),
  message: env(2, "message", {
    id: "msg-1",
    runId: "run-1",
    role: "user",
    content: [{ type: "text", text: "hello" }],
  }),
  tool_call: env(3, "tool_call", {
    runId: "run-1",
    toolUseId: "toolu_abc",
    name: "bash",
    input: { cmd: "ls" },
  }),
  tool_result: env(4, "tool_result", {
    runId: "run-1",
    toolUseId: "toolu_abc",
    name: "bash",
    content: [{ type: "text", text: "README.md" }],
    detail: { exitCode: 0 },
    isError: false,
  }),
  reasoning: env(5, "reasoning", {
    id: "rsn-1",
    runId: "run-1",
    text: "thinking about it",
  }),
  summarization: env(6, "summarization", {
    runId: "run-1",
    summary: "we dug",
    replacesThroughSeq: 4,
  }),
  state_snapshot: env(7, "state_snapshot", {
    state: { status: "active", context: [] },
    reason: "periodic",
  }),
  control: env(8, "control", { verb: "interrupt", reason: "user asked" }),
  error: env(9, "error", {
    runId: "run-1",
    code: "provider_timeout",
    message: "model call timed out",
    source: "provider",
  }),
  run_finished: env(10, "run_finished", {
    runId: "run-1",
    outcome: "success",
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900 },
  }),
  child_spawned: env(11, "child_spawned", {
    childId: "/t/default/a/worker/01jz00000000000000000000001",
    childType: "worker",
    runId: "run-1",
    toolUseId: "toolu_spawn",
  }),
  child_finished: env(12, "child_finished", {
    childId: "/t/default/a/worker/01jz00000000000000000000001",
    outcome: "success",
    result: { answer: 42 },
  }),
  opaque: env(13, "opaque", {
    origin: "casdk",
    kind: "session/file-history-snapshot",
    data: { type: "file-history-snapshot", files: ["a.ts"], nested: [1, null] },
  }),
  archived: env(14, "archived", { reason: "idle", snapshotSeq: 7 }),
};

describe("timeline event schema", () => {
  it("covers every declared event type with a fixture", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...EVENT_TYPES].sort());
  });

  for (const type of EVENT_TYPES) {
    it(`parses a valid ${type} event`, () => {
      const parsed = parseTimelineEvent(FIXTURES[type]);
      expect(parsed.type).toBe(type);
      expect(parsed.v).toBe(EVENT_SCHEMA_VERSION);
      expect(parsed.entityId).toBe(ENTITY);
    });
  }

  it("rejects an unknown event type", () => {
    const bad = env(0, "entity_spawned" as EventType, {});
    expect(safeParseTimelineEvent({ ...(bad as object), type: "mystery" }).success).toBe(false);
  });

  it("rejects a wrong schema version", () => {
    const ev = FIXTURES.message as Record<string, unknown>;
    expect(safeParseTimelineEvent({ ...ev, v: 2 }).success).toBe(false);
  });

  it("rejects negative and non-integer seq", () => {
    const ev = FIXTURES.message as Record<string, unknown>;
    expect(safeParseTimelineEvent({ ...ev, seq: -1 }).success).toBe(false);
    expect(safeParseTimelineEvent({ ...ev, seq: 1.5 }).success).toBe(false);
  });

  it("rejects a garbage timestamp (present but unparseable)", () => {
    const ev = FIXTURES.message as Record<string, unknown>;
    expect(safeParseTimelineEvent({ ...ev, ts: "not-a-date" }).success).toBe(false);
  });

  it("rejects payloads from the wrong event type", () => {
    const msg = FIXTURES.message as { payload: unknown };
    expect(safeParseTimelineEvent(env(3, "tool_call", msg.payload)).success).toBe(false);
  });

  it("rejects unknown message roles", () => {
    expect(
      safeParseTimelineEvent(
        env(2, "message", {
          id: "m",
          role: "system", // API-level system prompt is NOT a timeline role
          content: [{ type: "text", text: "x" }],
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts all three message roles", () => {
    for (const role of ["user", "assistant", "system_note"]) {
      expect(
        isTimelineEvent(
          env(2, "message", {
            id: "m",
            role,
            content: [{ type: "text", text: "x" }],
          }),
        ),
      ).toBe(true);
    }
  });

  it("parses from a JSON stream record", () => {
    const parsed = parseTimelineEventJson(JSON.stringify(FIXTURES.tool_call));
    expect(parsed.type).toBe("tool_call");
    if (parsed.type === "tool_call") {
      expect(parsed.payload.toolUseId).toBe("toolu_abc");
    }
  });

  it("discriminates the union for narrowing", () => {
    const parsed = timelineEventSchema.parse(FIXTURES.run_finished);
    if (parsed.type === "run_finished") {
      expect(parsed.payload.usage.inputTokens).toBe(100);
    } else {
      expect.unreachable("expected run_finished");
    }
  });
});

describe("opaque round-trip (R2/R3)", () => {
  it("carries a foreign CASDK record losslessly through parse→serialize→parse", () => {
    // A realistic CASDK session line teaspill has no native home for.
    const foreign = {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-07-16T09:00:00.000Z",
      uuid: "0c0ffee0-0000-4000-8000-000000000000",
      payload: { deeply: { nested: [1, "two", null, { three: true }] } },
    };
    const event = env(5, "opaque", {
      origin: "casdk",
      kind: "session/queue-operation",
      data: foreign,
    });
    const once = parseTimelineEvent(event);
    const twice = parseTimelineEventJson(JSON.stringify(once));
    expect(twice).toEqual(once);
    if (twice.type === "opaque") {
      expect(twice.payload.data).toEqual(foreign);
    }
  });
});

describe("finalizeEvent (harness → outbox hand-off)", () => {
  const init: TimelineEventInit = {
    ts: TS,
    type: "message",
    payload: {
      id: "msg-9",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  };

  it("stamps v/entityId/seq and validates", () => {
    const ev = finalizeEvent(init, { entityId: ENTITY, seq: 17 });
    expect(ev).toEqual({
      v: 1,
      entityId: ENTITY,
      seq: 17,
      ...init,
    });
  });

  it("refuses invalid finalization (negative seq)", () => {
    expect(() => finalizeEvent(init, { entityId: ENTITY, seq: -1 })).toThrow();
  });
});

describe("seq contiguity (A1: 0-based, gapless)", () => {
  const seqs = (...ns: number[]) => ns.map((seq) => ({ seq }));

  it("accepts a 0-based gapless timeline", () => {
    expect(checkSeqContiguity(seqs(0, 1, 2, 3))).toEqual({ ok: true });
  });

  it("rejects a timeline starting at 1", () => {
    expect(checkSeqContiguity(seqs(1, 2))).toEqual({
      ok: false,
      violationAt: 0,
      expectedSeq: 0,
    });
  });

  it("rejects a gap", () => {
    expect(checkSeqContiguity(seqs(0, 1, 3))).toEqual({
      ok: false,
      violationAt: 2,
      expectedSeq: 2,
    });
  });

  it("rejects a duplicate", () => {
    expect(checkSeqContiguity(seqs(0, 1, 1)).ok).toBe(false);
  });

  it("supports fast-join from a snapshot: snapshot(seq=N) then N+1, N+2…", () => {
    // T5.2 conformance rule: a client initializing from a snapshot at seq 7
    // must see exactly 8, 9, … next.
    expect(checkSeqContiguity(seqs(8, 9, 10), { expectedFirstSeq: 8 })).toEqual({ ok: true });
    expect(checkSeqContiguity(seqs(9, 10), { expectedFirstSeq: 8 }).ok).toBe(false);
  });

  it("a state_snapshot occupies a seq slot like any event (A1)", () => {
    const timeline = [
      FIXTURES.entity_spawned,
      FIXTURES.run_started,
      FIXTURES.message,
      FIXTURES.tool_call,
      FIXTURES.tool_result,
      FIXTURES.reasoning,
      FIXTURES.summarization,
      FIXTURES.state_snapshot, // seq 7 — consumes the slot, nothing skips
      FIXTURES.control,
      FIXTURES.error,
      FIXTURES.run_finished,
    ].map(parseTimelineEvent);
    expect(checkSeqContiguity(timeline)).toEqual({ ok: true });
    const snapshot = timeline[7]!;
    expect(snapshot.type).toBe("state_snapshot");
    expect(snapshot.seq).toBe(7);
  });
});

describe("timeline structural invariants", () => {
  const parseAll = (evs: unknown[]): TimelineEvent[] => evs.map(parseTimelineEvent);

  it("accepts the full fixture timeline", () => {
    expect(checkTimelineInvariants(parseAll(Object.values(FIXTURES)))).toEqual([]);
  });

  it("flags a timeline whose first event is not entity_spawned", () => {
    const violations = checkTimelineInvariants(
      parseAll([
        env(0, "run_started", {
          runId: "r",
          wake: { source: "spawn" },
          harness: "native",
        }),
      ]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/not entity_spawned/);
  });

  it("flags entity_spawned appearing after seq 0", () => {
    const spawnedLate = {
      ...(FIXTURES.entity_spawned as Record<string, unknown>),
      seq: 3,
    };
    const violations = checkTimelineInvariants(parseAll([spawnedLate]));
    expect(violations.some((v) => v.includes("entity_spawned at seq 3"))).toBe(true);
  });

  it("flags a summarization that claims to replace itself or the future", () => {
    const bad = env(6, "summarization", {
      summary: "s",
      replacesThroughSeq: 6,
    });
    const violations = checkTimelineInvariants(parseAll([bad]));
    expect(violations.some((v) => v.includes("replacesThroughSeq"))).toBe(true);
  });
});
