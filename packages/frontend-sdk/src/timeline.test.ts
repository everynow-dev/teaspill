/**
 * Store-level wiring tests for `createAgentTimeline`: drive the real
 * `@durable-streams/client` read path against a minimal in-process fake of
 * the durable-streams long-poll protocol (Content-Type + Stream-Next-Offset /
 * Stream-Up-To-Date / Stream-Closed headers, offset query param). The
 * reducer semantics themselves are covered by reducer.conformance.test.ts —
 * here we verify the wiring: parsing, offsets, fast-join pass-through, delta
 * interleaving through the wire, auth headers, and the drift callback.
 */

import { describe, expect, it, vi } from "vitest";
import { createAgentTimeline, deltasUrlFor } from "./timeline.js";
import { FIXTURE_SNAPSHOT_SEQ, FIXTURE_SNAPSHOT_STATE, delta, fullHistory } from "./fixtures.js";

const TIMELINE_URL = "http://gateway.test/streams/t/default/agents/researcher/01test/timeline";
const DELTAS_URL = "http://gateway.test/streams/t/default/agents/researcher/01test/deltas";

/**
 * Minimal durable-streams read fake: each stream is a list of batches; the
 * read offset is the batch index. The final batch (and any poll past it)
 * carries `Stream-Closed: true` so live sessions terminate deterministically.
 */
function fakeStreamFetch(
  streams: Record<string, unknown[][]>,
  seenRequests: Request[] = [],
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    seenRequests.push(req);
    const u = new URL(req.url);
    const key = u.origin + u.pathname;
    const batches = streams[key];
    if (batches === undefined) {
      return new Response(JSON.stringify({ error: "stream not found" }), { status: 404 });
    }
    const offsetParam = u.searchParams.get("offset") ?? "-1";
    const index = offsetParam === "-1" ? 0 : Number(offsetParam);
    const atEnd = index >= batches.length;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "stream-next-offset": String(Math.min(index + 1, batches.length)),
    };
    // Presence-checked headers: only set when true.
    if (index + 1 >= batches.length) headers["stream-up-to-date"] = "true";
    if (atEnd || index + 1 >= batches.length) headers["stream-closed"] = "true";
    if (atEnd) return new Response(null, { status: 204, headers });
    return new Response(JSON.stringify(batches[index]), { status: 200, headers });
  };
}

describe("deltasUrlFor", () => {
  it("derives the sibling /deltas URL", () => {
    expect(deltasUrlFor(TIMELINE_URL)).toBe(DELTAS_URL);
  });
  it("rejects non-timeline URLs", () => {
    expect(() => deltasUrlFor("http://x/streams/foo")).toThrow(/deltas/);
  });
});

describe("createAgentTimeline (through the wire)", () => {
  it("materializes a full replay and reports offset/upToDate", async () => {
    const history = fullHistory();
    const timeline = createAgentTimeline(TIMELINE_URL, {
      live: "long-poll",
      fetch: fakeStreamFetch({
        [TIMELINE_URL]: [history.slice(0, 10), history.slice(10)],
      }),
    });
    const state = await timeline.untilUpToDate();
    await timeline.closed;
    expect(state.timeline.appliedThroughSeq).toBe(history.at(-1)!.seq);
    expect(state.timeline.drift).toBeNull();
    expect(state.timeline.messages.map((m) => m.id)).toEqual([
      "m-u1",
      "m-a1",
      "m-a2",
      "m-b1",
      "m-u2",
      "m-c1",
    ]);
    expect(state.timeline.runs).toHaveLength(3);
    expect(state.upToDate).toBe(true);
    expect(state.streamOffset).toBe("2");
    expect(state.parseErrors).toBe(0);
  });

  it("fast-joins from a snapshot offset (0001:A7: snapshot@N then N+1…)", async () => {
    const history = fullHistory();
    const timeline = createAgentTimeline(TIMELINE_URL, {
      live: "long-poll",
      fromSnapshot: { seq: FIXTURE_SNAPSHOT_SEQ, offset: "1" },
      fetch: fakeStreamFetch({
        [TIMELINE_URL]: [
          history.slice(0, FIXTURE_SNAPSHOT_SEQ), // batch 0: pre-snapshot (never read)
          history.slice(FIXTURE_SNAPSHOT_SEQ), // batch 1: snapshot@15 + 16..24
        ],
      }),
    });
    const state = await timeline.untilUpToDate();
    await timeline.closed;
    expect(state.timeline.join).toEqual({
      mode: "snapshot",
      seq: FIXTURE_SNAPSHOT_SEQ,
      complete: true,
    });
    expect(state.timeline.entityState).toEqual(FIXTURE_SNAPSHOT_STATE);
    expect(state.timeline.appliedThroughSeq).toBe(history.at(-1)!.seq);
    expect(state.timeline.drift).toBeNull();
    // Only the post-join window is materialized.
    expect(state.timeline.messages.map((m) => m.id)).toEqual(["m-u2", "m-c1"]);
  });

  it("interleaves the sibling /deltas stream; finalized events win", async () => {
    const history = fullHistory();
    const timeline = createAgentTimeline(TIMELINE_URL, {
      live: "long-poll",
      deltas: true,
      fetch: fakeStreamFetch({
        [TIMELINE_URL]: [history], // includes the finalized message m-c1
        [DELTAS_URL]: [
          [
            delta({ kind: "text", ref: "m-c1", idx: 0, text: "here" }),
            delta({ kind: "text", ref: "m-c1", idx: 1, text: " you go" }),
            delta({ kind: "text", ref: "m-live", idx: 0, text: "still streaming" }),
          ],
        ],
      }),
    });
    await timeline.untilUpToDate();
    await timeline.closed;
    const s = timeline.getState();
    // m-c1 was finalized on the timeline → its deltas are superseded,
    // regardless of which session's batches applied first.
    expect(s.timeline.liveDeltas["m-c1"]).toBeUndefined();
    expect(s.timeline.messages.some((m) => m.id === "m-c1")).toBe(true);
    // m-live has no finalized event and belongs to a run that finished →
    // swept by run_finished. A ref from an unfinished run would survive; use
    // one with an unknown run to check retention:
    expect(s.timeline.liveDeltas["m-live"]).toBeUndefined();
  });

  it("keeps live deltas for unfinished runs", async () => {
    const history = fullHistory().filter((e) => e.seq <= 17); // run-c still open
    const timeline = createAgentTimeline(TIMELINE_URL, {
      live: "long-poll",
      deltas: true,
      fetch: fakeStreamFetch({
        [TIMELINE_URL]: [history],
        [DELTAS_URL]: [[delta({ kind: "text", ref: "m-c1", idx: 0, text: "streami" })]],
      }),
    });
    await timeline.untilUpToDate();
    await timeline.closed;
    expect(timeline.getState().timeline.liveDeltas["m-c1"]).toMatchObject({
      text: "streami",
      runId: "run-c",
    });
  });

  it("surfaces drift through onDrift (seq gap through the wire)", async () => {
    const history = fullHistory();
    const gapped = [...history.slice(0, 6), ...history.slice(7)];
    const onDrift = vi.fn();
    const timeline = createAgentTimeline(TIMELINE_URL, {
      live: "long-poll",
      onDrift,
      fetch: fakeStreamFetch({ [TIMELINE_URL]: [gapped] }),
    });
    await timeline.untilUpToDate();
    await timeline.closed;
    expect(onDrift).toHaveBeenCalledTimes(1);
    expect(onDrift.mock.calls[0]![0]).toMatchObject({ kind: "gap", expectedSeq: 6, gotSeq: 7 });
  });

  it("skips malformed records, counts them, and keeps folding", async () => {
    const history = fullHistory();
    const onRecordError = vi.fn();
    const timeline = createAgentTimeline(TIMELINE_URL, {
      live: "long-poll",
      onRecordError,
      fetch: fakeStreamFetch({
        [TIMELINE_URL]: [[history[0], { not: "an event" }, ...history.slice(1)]],
      }),
    });
    const state = await timeline.untilUpToDate();
    await timeline.closed;
    expect(state.parseErrors).toBe(1);
    expect(onRecordError).toHaveBeenCalledTimes(1);
    expect(state.timeline.appliedThroughSeq).toBe(history.at(-1)!.seq);
  });

  it("sends the auth credential on every request", async () => {
    const seen: Request[] = [];
    const timeline = createAgentTimeline(TIMELINE_URL, {
      live: "long-poll",
      auth: { token: () => "jwt-abc" },
      fetch: fakeStreamFetch({ [TIMELINE_URL]: [fullHistory()] }, seen),
    });
    await timeline.untilUpToDate();
    await timeline.closed;
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.headers.get("authorization")).toBe("Bearer jwt-abc");
    }
  });

  it("rejects untilUpToDate when the stream does not exist", async () => {
    const timeline = createAgentTimeline("http://gateway.test/streams/missing", {
      live: "long-poll",
      backoffOptions: { initialDelay: 1, maxDelay: 2, multiplier: 1 },
      fetch: fakeStreamFetch({}),
    });
    await expect(timeline.untilUpToDate()).rejects.toBeTruthy();
    timeline.close();
    await timeline.closed;
  });
});
