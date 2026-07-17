import { describe, expect, it } from "vitest";
import { resolveTimelineTarget, timelineStreamPath } from "./targets.js";

const GW = "http://localhost:8787";

describe("resolveTimelineTarget", () => {
  it("expands a short-form /a/<type>/<id> with the default tenant", () => {
    const r = resolveTimelineTarget("/a/researcher/r1", GW, "default");
    expect(r.entityUrl).toBe("/t/default/a/researcher/r1");
    expect(r.streamPath).toBe("/t/default/agents/researcher/r1/timeline");
    expect(r.streamUrl).toBe(
      "http://localhost:8787/streams/t/default/agents/researcher/r1/timeline",
    );
  });

  it("uses the tenant from a canonical url", () => {
    const r = resolveTimelineTarget("/t/team-x/a/worker/w9", GW, "default");
    expect(r.streamUrl).toBe("http://localhost:8787/streams/t/team-x/agents/worker/w9/timeline");
  });

  it("passes an absolute URL through unchanged", () => {
    const url = "http://localhost:8787/streams/t/default/agents/researcher/r1/timeline";
    const r = resolveTimelineTarget(url, GW, "default");
    expect(r.streamUrl).toBe(url);
  });

  it("rejects a non-target string", () => {
    expect(() => resolveTimelineTarget("nonsense", GW, "default")).toThrow(/not an entity target/);
  });
});

describe("timelineStreamPath", () => {
  it("follows addressing.md §4.2", () => {
    expect(timelineStreamPath("default", "t", "x")).toBe("/t/default/agents/t/x/timeline");
  });
});
