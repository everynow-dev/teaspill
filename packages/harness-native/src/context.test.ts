import { describe, expect, it } from "vitest";
import { parseTimelineEvent, type TimelineEvent } from "@teaspill/schema";
import { CONTEXT_BEARING_TYPES, isContextBearing, selectContextEvents } from "./context.js";

const ENTITY = "/t/default/a/researcher/01jz00000000000000000000000";
const TS = "2026-07-17T12:00:00.000Z";

function ev(seq: number, type: string, payload: unknown): TimelineEvent {
  return parseTimelineEvent({
    v: 1,
    entityId: ENTITY,
    seq,
    ts: TS,
    type,
    payload,
  });
}

const msg = (seq: number, role: string, text: string, id = `m${seq}`) =>
  ev(seq, "message", { id, role, content: [{ type: "text", text }] });

const TIMELINE: TimelineEvent[] = [
  ev(0, "entity_spawned", { entityType: "researcher", parentId: null }),
  ev(1, "run_started", {
    runId: "r1",
    wake: { source: "spawn" },
    harness: "native",
  }),
  msg(2, "user", "dig into X"),
  ev(3, "tool_call", {
    runId: "r1",
    toolUseId: "toolu_1",
    name: "bash",
    input: { cmd: "grep X" },
  }),
  ev(4, "tool_result", {
    runId: "r1",
    toolUseId: "toolu_1",
    content: [{ type: "text", text: "found it" }],
    isError: false,
  }),
  ev(5, "reasoning", { id: "rsn1", runId: "r1", text: "hmm, X implies Y" }),
  msg(6, "assistant", "X implies Y"),
  ev(7, "run_finished", {
    runId: "r1",
    outcome: "success",
    usage: { inputTokens: 10, outputTokens: 5 },
  }),
  ev(8, "state_snapshot", { state: { ok: true }, reason: "periodic" }),
  msg(9, "system_note", "child finished: worker-1"),
];

describe("context-bearing selection", () => {
  it("keeps exactly message/tool_call/tool_result/summarization", () => {
    expect([...CONTEXT_BEARING_TYPES].sort()).toEqual([
      "message",
      "summarization",
      "tool_call",
      "tool_result",
    ]);
    const selected = selectContextEvents(TIMELINE);
    expect(selected.map((e) => e.seq)).toEqual([2, 3, 4, 6, 9]);
    for (const e of selected) expect(isContextBearing(e)).toBe(true);
  });

  it("excludes reasoning (display-only history) and state_snapshot", () => {
    const types = selectContextEvents(TIMELINE).map((e) => e.type);
    expect(types).not.toContain("reasoning");
    expect(types).not.toContain("state_snapshot");
  });

  it("excludes foreign opaque by default, includes opted-in origins", () => {
    const opaque = ev(10, "opaque", {
      origin: "casdk",
      kind: "session/mode",
      data: { mode: "default" },
    });
    const timeline = [...TIMELINE, opaque];
    expect(selectContextEvents(timeline).map((e) => e.seq)).not.toContain(10);
    expect(
      selectContextEvents(timeline, { includeOpaqueOrigins: ["casdk"] }).map((e) => e.seq),
    ).toContain(10);
  });
});

describe("summarization fold (context-truncation boundary)", () => {
  const summarized: TimelineEvent[] = [
    ...TIMELINE,
    ev(10, "summarization", {
      runId: "r2",
      summary: "We established X implies Y.",
      replacesThroughSeq: 6,
    }),
    msg(11, "user", "now check Z"),
  ];

  it("drops context-bearing events at or below the boundary; keeps the summary + tail", () => {
    const selected = selectContextEvents(summarized);
    // seqs 2,3,4,6 are folded into the summary at seq 10; 9 and 11 survive.
    expect(selected.map((e) => e.seq)).toEqual([9, 10, 11]);
    expect(selected[1]!.type).toBe("summarization");
  });

  it("the latest summarization wins and earlier ones are folded away", () => {
    const twice: TimelineEvent[] = [
      ...summarized,
      msg(12, "assistant", "Z is fine"),
      ev(13, "summarization", {
        summary: "X implies Y; Z is fine.",
        replacesThroughSeq: 12,
      }),
      msg(14, "user", "great, wrap up"),
    ];
    const selected = selectContextEvents(twice);
    expect(selected.map((e) => e.seq)).toEqual([13, 14]);
  });

  it("rejects out-of-order input (trust but verify)", () => {
    expect(() => selectContextEvents([msg(2, "user", "b"), msg(1, "user", "a")])).toThrow(
      /ascending seq/,
    );
  });
});
