import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_TOOL_RESULT_TEXT,
  chainLines,
  contentBlocksOf,
  isContentLine,
  parseSessionLines,
  repairSessionLines,
  serializeSessionLines,
  type SessionLine,
} from "./session-lines.js";
import { seqUuid } from "./testing.js";

const userLine = (text: string, uuid?: string): SessionLine => ({
  type: "user",
  ...(uuid !== undefined && { uuid }),
  message: { role: "user", content: [{ type: "text", text }] },
});
const toolUseLine = (id: string, uuid?: string): SessionLine => ({
  type: "assistant",
  ...(uuid !== undefined && { uuid }),
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "mcp__teaspill__t", input: {} }] },
});
const toolResultLine = (id: string): SessionLine => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "ok" }] }] },
});

describe("chainLines", () => {
  it("chains uuid/parentUuid and emits monotonic parseable timestamps", () => {
    const lines = chainLines(
      [{ type: "user", message: { role: "user", content: [{ type: "text", text: "a" }] } }, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "b" }] } }],
      { newUuid: seqUuid(), baseTimeMs: 1000 },
    );
    expect(lines[0]!.parentUuid).toBeNull();
    expect(lines[1]!.parentUuid).toBe(lines[0]!.uuid);
    const t0 = Date.parse(lines[0]!.timestamp!);
    const t1 = Date.parse(lines[1]!.timestamp!);
    expect(Number.isNaN(t0)).toBe(false);
    expect(t1).toBeGreaterThan(t0);
  });
});

describe("serialize/parse", () => {
  it("round-trips JSONL", () => {
    const lines = [userLine("hi"), { type: "queue-operation", operation: "x" }];
    expect(parseSessionLines(serializeSessionLines(lines))).toEqual(lines);
  });
});

describe("repairSessionLines", () => {
  const opts = (): { newUuid: () => string; now: () => number } => ({ newUuid: seqUuid("rep"), now: () => 5000 });

  it("returns healthy transcripts unchanged", () => {
    const lines = [userLine("q"), toolUseLine("t1"), toolResultLine("t1")];
    const res = repairSessionLines(lines, opts());
    expect(res.lines).toEqual(lines);
    expect(res.repairedToolUseIds).toEqual([]);
    expect(res.droppedOrphanResults).toBe(0);
  });

  it("synthesizes an error tool_result after a dangling tool_use tail", () => {
    const lines = [userLine("q", "u1"), toolUseLine("t1", "u2")];
    const res = repairSessionLines(lines, opts());
    expect(res.repairedToolUseIds).toEqual(["t1"]);
    const last = res.lines.at(-1)!;
    expect(isContentLine(last)).toBe(true);
    const block = contentBlocksOf(last)[0] as { type: string; tool_use_id: string; is_error?: boolean; content?: Array<{ text: string }> };
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("t1");
    expect(block.is_error).toBe(true);
    expect(block.content?.[0]?.text).toBe(INTERRUPTED_TOOL_RESULT_TEXT);
    expect(last.parentUuid).toBe("u2"); // chained onto the leaf
  });

  it("drops orphan tool_results and passes meta lines through", () => {
    const meta: SessionLine = { type: "file-history-snapshot", snapshot: {} };
    const res = repairSessionLines([userLine("q"), meta, toolResultLine("ghost")], opts());
    expect(res.droppedOrphanResults).toBe(1);
    expect(res.lines).toEqual([userLine("q"), meta]);
  });

  it("repairs a dangling tool_use in the middle (dropped mirror batch shape)", () => {
    const lines = [userLine("q"), toolUseLine("t1"), toolUseLine("t2"), toolResultLine("t2")];
    const res = repairSessionLines(lines, opts());
    expect(res.repairedToolUseIds).toEqual(["t1"]);
    // Synthetic result sits immediately after the t1 tool_use line.
    const idx = res.lines.findIndex((l) => contentBlocksOf(l).some((b) => b.type === "tool_use" && (b as { id?: string }).id === "t1"));
    const next = contentBlocksOf(res.lines[idx + 1]!)[0] as { tool_use_id?: string };
    expect(next.tool_use_id).toBe("t1");
  });
});
