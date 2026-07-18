/**
 * pi context assembly (0001:T3.2) — pure canonical→provider rendering tests
 * (the normative 0001:T3.1 rules + electric's toAgentHistory merge semantics).
 */

import { describe, expect, it } from "vitest";
import { finalizeEvent } from "@teaspill/schema";
import type { TimelineEvent, TimelineEventInit } from "@teaspill/schema";
import {
  DANGLING_TOOL_RESULT_TEXT,
  SUMMARY_MARKER,
  SYSTEM_NOTE_MARKER,
  assemblePiContext,
  estimateMessageTokens,
  latestContextBearingSeq,
  repairDanglingToolCalls,
} from "./pi-context.js";
import type { PiHistoryMessage } from "./pi-client.js";

const ENTITY = "/t/default/a/researcher/r1";
const TS = "2026-07-17T12:00:00.000Z";

function events(...inits: TimelineEventInit[]): TimelineEvent[] {
  return inits.map((init, i) => finalizeEvent(init, { entityId: ENTITY, seq: i }));
}

const user = (text: string, id = "u"): TimelineEventInit => ({
  type: "message",
  ts: TS,
  payload: { id, role: "user", content: [{ type: "text", text }] },
});
const assistant = (text: string, id = "a"): TimelineEventInit => ({
  type: "message",
  ts: TS,
  payload: { id, role: "assistant", content: [{ type: "text", text }] },
});
const toolCall = (toolUseId: string, name = "echo"): TimelineEventInit => ({
  type: "tool_call",
  ts: TS,
  payload: { runId: "r", toolUseId, name, input: { x: 1 } },
});
const toolResult = (toolUseId: string, text = "ok"): TimelineEventInit => ({
  type: "tool_result",
  ts: TS,
  payload: {
    runId: "r",
    toolUseId,
    name: "echo",
    content: [{ type: "text", text }],
    isError: false,
  },
});

describe("assemblePiContext (§7 rendering rules)", () => {
  it("renders user / assistant / tool_call / tool_result with assistant merging", () => {
    const msgs = assemblePiContext(
      events(user("hi"), assistant("thinking out loud"), toolCall("tu-1"), toolResult("tu-1")),
    );
    expect(msgs).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking out loud" },
          { type: "toolCall", toolUseId: "tu-1", name: "echo", input: { x: 1 } },
        ],
      },
      {
        role: "toolResult",
        toolUseId: "tu-1",
        toolName: "echo",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies PiHistoryMessage[]);
  });

  it("concatenates consecutive assistant text (toAgentHistory merge semantics)", () => {
    const msgs = assemblePiContext(events(user("q"), assistant("part one, ", "a1"), assistant("part two", "a2")));
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "part one, part two" }],
    });
  });

  it("renders system_note as a MARKED user message, never an API system prompt", () => {
    const msgs = assemblePiContext(
      events(user("q"), {
        type: "message",
        ts: TS,
        payload: {
          id: "n1",
          role: "system_note",
          content: [{ type: "text", text: "child finished: ok" }],
        },
      }),
    );
    expect(msgs[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: `${SYSTEM_NOTE_MARKER} child finished: ok` }],
    });
  });

  it("folds via the winning summarization and renders its summary as a marked user note", () => {
    const msgs = assemblePiContext(
      events(user("old input"), assistant("old reply"), {
        type: "summarization",
        ts: TS,
        payload: { summary: "the gist", replacesThroughSeq: 1 },
      }),
    );
    expect(msgs).toEqual([
      { role: "user", content: [{ type: "text", text: `${SUMMARY_MARKER} the gist` }] },
    ]);
  });

  it("drops non-context-bearing events (reasoning stays display-only) and foreign opaques", () => {
    const msgs = assemblePiContext(
      events(
        user("q"),
        {
          type: "reasoning",
          ts: TS,
          payload: { id: "rsn", text: "secret thinking", encrypted: "sig" },
        },
        { type: "opaque", ts: TS, payload: { origin: "casdk", kind: "session/x", data: {} } },
        {
          type: "run_started",
          ts: TS,
          payload: { runId: "r", wake: { source: "message" }, harness: "native" },
        },
      ),
    );
    expect(msgs).toEqual([{ role: "user", content: [{ type: "text", text: "q" }] }]);
  });

  it("preserves IMAGE blocks in user and tool_result content (frozen ContentBlock, text+image)", () => {
    const img = { type: "image" as const, mimeType: "image/png", data: "YmFzZTY0" };
    const msgs = assemblePiContext(
      events(
        {
          type: "message",
          ts: TS,
          payload: {
            id: "u1",
            role: "user",
            content: [{ type: "text", text: "look:" }, img],
          },
        },
        toolCall("tu-1", "screenshot"),
        {
          type: "tool_result",
          ts: TS,
          payload: {
            runId: "r",
            toolUseId: "tu-1",
            name: "screenshot",
            content: [{ type: "text", text: "captured" }, img],
            isError: false,
          },
        },
      ),
    );
    expect(msgs[0]!.content).toEqual([{ type: "text", text: "look:" }, img]);
    const tr = msgs.find((m) => m.role === "toolResult")!;
    expect(tr.content).toEqual([{ type: "text", text: "captured" }, img]);
  });

  it("repairs a dangling tool_call with a synthesized error result before later messages", () => {
    const msgs = assemblePiContext(
      events(user("q"), toolCall("tu-lost"), user("next wake input", "u2")),
    );
    expect(msgs).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", toolUseId: "tu-lost", name: "echo", input: { x: 1 } }],
      },
      {
        role: "toolResult",
        toolUseId: "tu-lost",
        toolName: "echo",
        content: [{ type: "text", text: DANGLING_TOOL_RESULT_TEXT }],
        isError: true,
      },
      { role: "user", content: [{ type: "text", text: "next wake input" }] },
    ]);
  });
});

describe("repairDanglingToolCalls", () => {
  it("is a no-op (same content) when every call is resolved", () => {
    const msgs: PiHistoryMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", toolUseId: "t1", name: "n", input: null }],
      },
      { role: "toolResult", toolUseId: "t1", toolName: "n", content: [], isError: false },
    ];
    expect(repairDanglingToolCalls(msgs)).toEqual(msgs);
  });

  it("repairs trailing dangling calls at the end of history", () => {
    const msgs: PiHistoryMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", toolUseId: "t1", name: "n", input: null }],
      },
    ];
    const repaired = repairDanglingToolCalls(msgs);
    expect(repaired).toHaveLength(2);
    expect(repaired[1]).toMatchObject({ role: "toolResult", toolUseId: "t1", isError: true });
  });
});

describe("latestContextBearingSeq", () => {
  it("returns the highest context-bearing seq (fold boundary), post-fold", () => {
    expect(latestContextBearingSeq(events(user("a"), assistant("b")))).toBe(1);
    expect(
      latestContextBearingSeq(
        events(user("a"), {
          type: "run_started",
          ts: TS,
          payload: { runId: "r", wake: { source: "message" }, harness: "native" },
        }),
      ),
    ).toBe(0);
    expect(latestContextBearingSeq([])).toBeNull();
  });
});

describe("estimateMessageTokens", () => {
  it("is deterministic and scales with content size", () => {
    const small: PiHistoryMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const big: PiHistoryMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi".repeat(500) }] },
    ];
    expect(estimateMessageTokens(small)).toBe(estimateMessageTokens(small));
    expect(estimateMessageTokens(big)).toBeGreaterThan(estimateMessageTokens(small));
  });
});
