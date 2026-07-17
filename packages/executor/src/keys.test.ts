import { describe, expect, it } from "vitest";
import {
  assertExecId,
  execIdFromInvocationId,
  parseWorkspaceKey,
  workspaceExecStdoutStreamPath,
  workspaceKey,
  workspaceStdoutStreamPath,
} from "./keys.js";

describe("workspace keys (addressing §5/§4.3)", () => {
  it("builds and parses `<tenant>/<name>` keys", () => {
    expect(workspaceKey("default", "a-researcher-01j9")).toBe("default/a-researcher-01j9");
    expect(parseWorkspaceKey("default/a-researcher-01j9")).toEqual({
      tenant: "default",
      name: "a-researcher-01j9",
    });
  });

  it("rejects malformed keys (empty, missing separator, bad charset, traversal)", () => {
    for (const bad of [
      "",
      "noslash",
      "/leading",
      "trailing/",
      "UPPER/name",
      "t/../x",
      "t/na me",
      "t/.dot",
    ]) {
      expect(() => parseWorkspaceKey(bad), bad).toThrow(/invalid/);
    }
  });

  it("derives stream paths from the key", () => {
    expect(workspaceStdoutStreamPath("default/ws1")).toBe("/t/default/workspaces/ws1/stdout");
    expect(workspaceExecStdoutStreamPath("default/ws1", "e-1")).toBe(
      "/t/default/workspaces/ws1/exec/e-1/stdout",
    );
    expect(() => workspaceExecStdoutStreamPath("default/ws1", "../evil")).toThrow(/invalid execId/);
  });

  it("sanitizes Restate invocation ids into the exec-id charset, deterministically", () => {
    const a = execIdFromInvocationId("inv_1ABC-def.ghi");
    expect(a).toBe("x-inv_1abc-defghi");
    expect(execIdFromInvocationId("inv_1ABC-def.ghi")).toBe(a); // stable across retries
    expect(() => assertExecId(a)).not.toThrow();
    // pathological ids still produce a valid id
    expect(() => assertExecId(execIdFromInvocationId("___"))).not.toThrow();
    expect(execIdFromInvocationId("A".repeat(200)).length).toBeLessThanOrEqual(64);
  });
});
