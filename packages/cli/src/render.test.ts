import { describe, expect, it } from "vitest";
import { applyTimelineEvents, initialTimelineState } from "@teaspill/frontend-sdk";
import { finalizeEvent, type TimelineEvent, type TimelineEventInit } from "@teaspill/schema";
import { collectRenderable, renderContent, renderNewLines } from "./render.js";

const ENTITY = "/t/default/a/researcher/r1";
const ts = (seq: number): string => new Date(Date.UTC(2026, 6, 17, 12, 0, seq)).toISOString();

function evt(seq: number, init: Omit<TimelineEventInit, "ts">): TimelineEvent {
  return finalizeEvent({ ...init, ts: ts(seq) } as TimelineEventInit, { entityId: ENTITY, seq });
}

/** A small canonical history exercising each render branch. */
function cannedStream(): TimelineEvent[] {
  return [
    evt(0, { type: "entity_spawned", payload: { entityType: "researcher", parentId: null } }),
    evt(1, {
      type: "run_started",
      payload: { runId: "run-a", wake: { source: "spawn" }, harness: "native", model: "m-1" },
    }),
    evt(2, {
      type: "message",
      payload: {
        id: "m-u1",
        runId: "run-a",
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    }),
    evt(3, {
      type: "tool_call",
      payload: { runId: "run-a", toolUseId: "t1", name: "bash", input: { cmd: "ls" } },
    }),
    evt(4, {
      type: "tool_result",
      payload: {
        runId: "run-a",
        toolUseId: "t1",
        name: "bash",
        content: [{ type: "text", text: "README.md" }],
        isError: false,
      },
    }),
    evt(5, {
      type: "message",
      payload: {
        id: "m-a1",
        runId: "run-a",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    }),
    evt(6, {
      type: "run_finished",
      payload: {
        runId: "run-a",
        outcome: "success",
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 1200,
      },
    }),
    evt(7, {
      type: "error",
      payload: { runId: "run-a", source: "tool", code: "E_BASH", message: "command failed" },
    }),
  ];
}

describe("renderContent", () => {
  it("joins text blocks and marks images", () => {
    expect(
      renderContent([
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ]),
    ).toBe("hello [image image/png]");
  });
});

describe("collectRenderable — renders a canned event stream readably", () => {
  const state = applyTimelineEvents(initialTimelineState(), cannedStream());
  const lines = collectRenderable(state);

  it("emits lines in seq order", () => {
    const seqs = lines.map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("renders run boundaries, messages, tool call + result, and errors", () => {
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("spawned researcher");
    expect(text).toContain("run run-a started");
    expect(text).toContain("native m-1");
    expect(text).toContain("user: hi");
    expect(text).toContain('tool bash({"cmd":"ls"})');
    expect(text).toContain("ok bash: README.md");
    expect(text).toContain("assistant: done");
    expect(text).toContain("run run-a success");
    expect(text).toContain("tokens=150");
    expect(text).toContain("1200ms");
    expect(text).toContain("error [tool/E_BASH]: command failed");
  });

  it("produces a separate line for the tool call (seq 3) and its result (seq 4)", () => {
    expect(lines.find((l) => l.seq === 3)?.text).toContain("⚙ tool bash");
    expect(lines.find((l) => l.seq === 4)?.text).toContain("bash: README.md");
  });
});

describe("renderNewLines — watermark", () => {
  it("only returns lines beyond the watermark", () => {
    const state = applyTimelineEvents(initialTimelineState(), cannedStream());
    const afterFour = renderNewLines(state, 4);
    expect(afterFour.every((l) => l.seq > 4)).toBe(true);
    expect(afterFour.map((l) => l.seq)).toEqual([5, 6, 7]);
  });
});
