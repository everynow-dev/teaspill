import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@teaspill/harness-native", () => {
  it("exposes its package name as a placeholder export", () => {
    expect(packageName).toBe("@teaspill/harness-native");
  });
});
