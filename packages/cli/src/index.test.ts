import { describe, expect, it } from "vitest";
import { packageName, run } from "./index.js";

describe("@teaspill/cli", () => {
  it("exposes its package name as a placeholder export", () => {
    expect(packageName).toBe("@teaspill/cli");
  });

  it("run() reports unimplemented commands instead of throwing", () => {
    expect(run(["agents"])).toContain("not implemented yet");
  });
});
