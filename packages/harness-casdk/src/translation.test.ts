import { describe, expect, it } from "vitest";
import { finalizeEvent, type TimelineEvent } from "@teaspill/schema";
import { SUMMARY_MARKER, SYSTEM_NOTE_MARKER } from "@teaspill/harness-native";
import {
  contentToSessionBlocks,
  eventToLineBodies,
  fromMcpName,
  getTranslation,
  sessionBlocksToContent,
  sessionLineToEvents,
  supportedSdkVersions,
  toMcpName,
} from "./translation.js";
import { PINNED_SDK_VERSION } from "./sdk-client.js";

const ev = (type: string, payload: unknown, seq = 1): TimelineEvent =>
  finalizeEvent({ type, ts: "2026-01-01T00:00:00.000Z", payload } as never, {
    entityId: "/t/default/a/x/y",
    seq,
  });

describe("versioning (R3)", () => {
  it("has a branch for the pinned version and throws on unknown versions", () => {
    expect(supportedSdkVersions()).toContain(PINNED_SDK_VERSION);
    expect(getTranslation(PINNED_SDK_VERSION).sdkVersion).toBe(PINNED_SDK_VERSION);
    expect(() => getTranslation("9.9.9")).toThrow(/no translation table.*9\.9\.9/s);
  });

  it("enumerates known-drop chatter and keeps mirror_error out of it", () => {
    const t = getTranslation();
    expect(t.isKnownDrop({ type: "system", subtype: "status" })).toBe(true);
    expect(t.isKnownDrop({ type: "rate_limit_event" })).toBe(true);
    expect(t.isKnownDrop({ type: "tool_progress" })).toBe(true);
    expect(t.isKnownDrop({ type: "system", subtype: "mirror_error" })).toBe(false);
    expect(t.isKnownDrop({ type: "totally_new_thing" })).toBe(false);
  });
});

describe("MCP naming", () => {
  it("qualifies and de-qualifies; foreign names pass through", () => {
    expect(toMcpName("spawn_agent")).toBe("mcp__teaspill__spawn_agent");
    expect(fromMcpName("mcp__teaspill__spawn_agent")).toBe("spawn_agent");
    expect(fromMcpName("mcp__other__x")).toBe("mcp__other__x");
  });
});

describe("content block conversion", () => {
  it("round-trips text and image blocks", () => {
    const content = [
      { type: "text" as const, text: "hi" },
      { type: "image" as const, mimeType: "image/png", data: "QUJD" },
    ];
    expect(sessionBlocksToContent(contentToSessionBlocks(content))).toEqual(content);
  });
});

describe("eventToLineBodies (§3)", () => {
  it("maps the four line shapes", () => {
    expect(eventToLineBodies(ev("message", { id: "m", role: "user", content: [{ type: "text", text: "q" }] }))).toEqual([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "q" }] } },
    ]);
    // assistant: one block per line
    const multi = eventToLineBodies(
      ev("message", {
        id: "m",
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    );
    expect(multi).toHaveLength(2);
    expect(multi.every((l) => l.type === "assistant")).toBe(true);

    const call = eventToLineBodies(ev("tool_call", { runId: "r", toolUseId: "t1", name: "web_search", input: { q: 1 } }))[0]!;
    expect((call.message!.content as Array<{ name: string }>)[0]!.name).toBe("mcp__teaspill__web_search");

    const ok = eventToLineBodies(ev("tool_result", { runId: "r", toolUseId: "t1", content: [{ type: "text", text: "r" }], isError: false }))[0]!;
    expect((ok.message!.content as Array<{ is_error?: boolean }>)[0]!.is_error).toBeUndefined();
    const err = eventToLineBodies(ev("tool_result", { runId: "r", toolUseId: "t1", content: [], isError: true }))[0]!;
    expect((err.message!.content as Array<{ is_error?: boolean }>)[0]!.is_error).toBe(true);
  });

  it("marks system notes and summaries; replays casdk session opaques; skips others", () => {
    const note = eventToLineBodies(ev("message", { id: "m", role: "system_note", content: [{ type: "text", text: "child done" }] }))[0]!;
    expect((note.message!.content as Array<{ text: string }>)[0]!.text).toBe(`${SYSTEM_NOTE_MARKER} child done`);

    const sum = eventToLineBodies(ev("summarization", { summary: "S", replacesThroughSeq: 0 }, 5))[0]!;
    expect((sum.message!.content as Array<{ text: string }>)[0]!.text).toBe(`${SUMMARY_MARKER} S`);

    const replay = eventToLineBodies(
      ev("opaque", { origin: "casdk", kind: "session/mode", data: { type: "mode", mode: "x", uuid: "old", timestamp: "old" } }),
    );
    expect(replay).toEqual([{ type: "mode", mode: "x" }]); // chain identity stripped

    expect(eventToLineBodies(ev("opaque", { origin: "casdk", kind: "stream/foo", data: {} }))).toEqual([]);
    expect(eventToLineBodies(ev("opaque", { origin: "pi-ai", kind: "session/x", data: {} }))).toEqual([]);
    expect(eventToLineBodies(ev("control", { verb: "interrupt" }))).toEqual([]);
  });
});

describe("sessionLineToEvents (inverse)", () => {
  it("inverts the markers and tool blocks", () => {
    const note = sessionLineToEvents({
      type: "user",
      uuid: "u",
      message: { role: "user", content: [{ type: "text", text: `${SYSTEM_NOTE_MARKER} child done` }] },
    })[0]!;
    expect(note.type).toBe("message");
    expect((note as { payload: { role: string; content: Array<{ text: string }> } }).payload.role).toBe("system_note");
    expect((note as { payload: { content: Array<{ text: string }> } }).payload.content[0]!.text).toBe("child done");

    const sum = sessionLineToEvents({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `${SUMMARY_MARKER} S` }] },
    })[0]!;
    expect(sum.type).toBe("summarization");

    const call = sessionLineToEvents({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__teaspill__web_search", input: { q: 1 } }] },
    })[0]!;
    expect(call).toMatchObject({ type: "tool_call", payload: { toolUseId: "t1", name: "web_search", input: { q: 1 } } });

    const res = sessionLineToEvents({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "plain", is_error: true }] },
    })[0]!;
    expect(res).toMatchObject({ type: "tool_result", payload: { toolUseId: "t1", isError: true, content: [{ type: "text", text: "plain" }] } });
  });

  it("meta lines become session/* opaques; thinking blocks are dropped", () => {
    const meta = sessionLineToEvents({ type: "ai-title", title: "x" })[0]!;
    expect(meta).toMatchObject({ type: "opaque", payload: { origin: "casdk", kind: "session/ai-title" } });

    const think = sessionLineToEvents({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "sig" }] },
    });
    expect(think).toEqual([]); // §4.5 asymmetry — capture records reasoning live
  });
});
