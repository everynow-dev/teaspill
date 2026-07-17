import { describe, expect, it } from "vitest";
import { buildCli, collectRenderable, packageName, resolveConfig, run } from "./index.js";
import { fakeDeps } from "./fakes.js";

describe("@teaspill/cli", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@teaspill/cli");
  });

  it("re-exports the public surface (run, buildCli, config, render)", () => {
    expect(run).toBeTypeOf("function");
    expect(buildCli).toBeTypeOf("function");
    expect(resolveConfig).toBeTypeOf("function");
    expect(collectRenderable).toBeTypeOf("function");
  });

  it("run() with no args prints help and returns 0 (does not throw)", async () => {
    const { deps } = fakeDeps();
    await expect(run([], deps)).resolves.toBe(0);
  });
});
