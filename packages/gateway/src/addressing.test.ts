import { describe, expect, it } from "vitest";
import {
  AddressingError,
  assertInstanceId,
  entityUrl,
  newInstanceId,
  parseEntityUrl,
  restateAgentKey,
  timelineStreamPath,
} from "./addressing.js";

describe("addressing (ported from https://teaspill.everynow.dev/reference/addressing)", () => {
  it("builds and parses the canonical entity url", () => {
    const url = entityUrl("default", "researcher", "01j9z8k3q");
    expect(url).toBe("/t/default/a/researcher/01j9z8k3q");
    expect(parseEntityUrl(url)).toEqual({
      tenant: "default",
      type: "researcher",
      id: "01j9z8k3q",
    });
  });

  it("rejects malformed segments", () => {
    expect(() => entityUrl("default", "Bad.Type", "x")).toThrow(AddressingError);
    expect(() => entityUrl("default", "researcher", "")).toThrow(AddressingError);
    expect(() => entityUrl("", "researcher", "x")).toThrow(AddressingError);
    expect(() => parseEntityUrl("/a/researcher/x")).toThrow(AddressingError); // short form is not canonical
    expect(() => parseEntityUrl("/t/default/a/researcher/x/extra")).toThrow(AddressingError);
  });

  it("enforces segment length caps", () => {
    expect(() => entityUrl("default", "researcher", "a".repeat(64))).not.toThrow();
    expect(() => entityUrl("default", "researcher", "a".repeat(65))).toThrow(AddressingError);
    expect(() => entityUrl("a".repeat(33), "researcher", "x")).toThrow(AddressingError);
  });

  it("derives the timeline stream path (agents collection, not the `a` marker)", () => {
    expect(timelineStreamPath("/t/default/a/researcher/r1")).toBe(
      "/t/default/agents/researcher/r1/timeline",
    );
  });

  it("derives the Restate target: service agent.<type>, key <id>", () => {
    expect(restateAgentKey("/t/default/a/researcher/r1")).toEqual({
      service: "agent.researcher",
      key: "r1",
    });
  });

  it("mints valid lowercase ULID instance ids", () => {
    const id = newInstanceId();
    expect(id).toHaveLength(26);
    expect(() => assertInstanceId(id)).not.toThrow();
    expect(id).toBe(id.toLowerCase());
  });

  it("rejects the empty instance id (0001:A3: no empty Restate keys)", () => {
    expect(() => assertInstanceId("")).toThrow(AddressingError);
  });
});
