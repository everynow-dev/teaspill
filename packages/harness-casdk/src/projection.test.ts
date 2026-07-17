import { describe, expect, it } from "vitest";
import { finalizeEvent, type TimelineEvent } from "@teaspill/schema";
import { SUMMARY_MARKER } from "@teaspill/harness-native";
import {
  projectCanonicalToSession,
  repairContextEvents,
  splitTrailingUserEvents,
} from "./projection.js";
import { contentBlocksOf } from "./session-lines.js";
import { FIXTURE_BASE_MS, FIXTURE_ENTITY, fixtureTimeline, seqUuid } from "./testing.js";

const mk = (inits: Array<{ type: string; payload: unknown }>): TimelineEvent[] =>
  inits.map((i, seq) =>
    finalizeEvent({ ...i, ts: "2026-01-01T00:00:00.000Z" } as never, { entityId: FIXTURE_ENTITY, seq }),
  );

describe("splitTrailingUserEvents", () => {
  it("moves only the trailing user-side run to the feed", () => {
    const events = mk([
      { type: "entity_spawned", payload: { entityType: "x", parentId: null } },
      { type: "message", payload: { id: "1", role: "user", content: [{ type: "text", text: "a" }] } },
      { type: "message", payload: { id: "2", role: "assistant", content: [{ type: "text", text: "b" }] } },
      { type: "message", payload: { id: "3", role: "system_note", content: [{ type: "text", text: "n" }] } },
      { type: "message", payload: { id: "4", role: "user", content: [{ type: "text", text: "c" }] } },
    ]);
    const { transcript, feed } = splitTrailingUserEvents(events);
    expect(feed.map((e) => e.seq)).toEqual([3, 4]);
    expect(transcript.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("repairContextEvents", () => {
  it("pairs a dangling tool_call and drops orphan results", () => {
    const events = mk([
      { type: "tool_result", payload: { runId: "r", toolUseId: "ghost", content: [], isError: false } },
      { type: "tool_call", payload: { runId: "r", toolUseId: "t1", name: "x", input: {} } },
    ]);
    const { events: out, repairedToolUseIds } = repairContextEvents(events);
    expect(repairedToolUseIds).toEqual(["t1"]);
    expect(out.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    expect((out[1] as Extract<TimelineEvent, { type: "tool_result" }>).payload.isError).toBe(true);
  });
});

describe("projectCanonicalToSession", () => {
  it("projects the fixture per the §3 table (fold, markers, opaque replay, feed split)", () => {
    const { lines, feedEvents, idMap, repairedToolUseIds } = projectCanonicalToSession(fixtureTimeline(), {
      newUuid: seqUuid(),
      baseTimeMs: FIXTURE_BASE_MS,
    });
    expect(repairedToolUseIds).toEqual([]);
    // Trailing wake goes to the feed, not the transcript.
    expect(feedEvents.map((e) => e.seq)).toEqual([11]);
    // reasoning (seq3) skipped; non-context events skipped; 7 lines total.
    expect(lines.map((l) => l.type)).toEqual([
      "user", // wake a
      "assistant", // text
      "assistant", // tool_use
      "user", // tool_result
      "assistant", // final text
      "user", // system note
      "queue-operation", // opaque replay
    ]);
    expect(lines[0]!.parentUuid).toBeNull();
    expect(lines.slice(1, 6).every((l, i) => l.parentUuid === lines[i]!.uuid)).toBe(true);
    // ID map is bidirectional and regenerable.
    expect(idMap.toSession["tool_call:toolu_001"]).toEqual([lines[2]!.uuid]);
    expect(idMap.toCanonical[lines[2]!.uuid!]).toBe("tool_call:toolu_001");
  });

  it("summarization fold wins on cold rebuild (D5 layer 3)", () => {
    const events = mk([
      { type: "entity_spawned", payload: { entityType: "x", parentId: null } },
      { type: "message", payload: { id: "1", role: "user", content: [{ type: "text", text: "old" }] } },
      { type: "message", payload: { id: "2", role: "assistant", content: [{ type: "text", text: "old answer" }] } },
      { type: "summarization", payload: { summary: "The old stuff happened.", replacesThroughSeq: 2 } },
      { type: "message", payload: { id: "3", role: "assistant", content: [{ type: "text", text: "post-fold" }] } },
    ]);
    const { lines } = projectCanonicalToSession(events, { newUuid: seqUuid(), baseTimeMs: 0 });
    expect(lines).toHaveLength(2);
    expect(contentBlocksOf(lines[0]!)[0]).toMatchObject({ text: `${SUMMARY_MARKER} The old stuff happened.` });
    expect(lines[0]!.type).toBe("user"); // summary line is user-side → valid first line
    expect(contentBlocksOf(lines[1]!)[0]).toMatchObject({ text: "post-fold" });
  });

  it("prepends a rebuild marker when the transcript would open on an assistant line", () => {
    const events = mk([
      { type: "entity_spawned", payload: { entityType: "x", parentId: null } },
      { type: "message", payload: { id: "1", role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ]);
    const { lines } = projectCanonicalToSession(events, { newUuid: seqUuid(), baseTimeMs: 0 });
    expect(lines[0]!.type).toBe("user");
    expect(contentBlocksOf(lines[0]!)[0]).toMatchObject({ text: "[session rebuilt from canonical timeline]" });
  });

  it("a wake-only timeline projects to zero lines and a pure feed (fresh session)", () => {
    const events = mk([
      { type: "entity_spawned", payload: { entityType: "x", parentId: null } },
      { type: "message", payload: { id: "1", role: "user", content: [{ type: "text", text: "first wake" }] } },
    ]);
    const { lines, feedEvents } = projectCanonicalToSession(events, { newUuid: seqUuid(), baseTimeMs: 0 });
    expect(lines).toEqual([]);
    expect(feedEvents.map((e) => e.seq)).toEqual([1]);
  });
});
