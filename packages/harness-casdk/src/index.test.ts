import { describe, expect, it } from "vitest";
import * as pkg from "./index.js";

describe("@teaspill/harness-casdk", () => {
  it("exports the harness surface", () => {
    expect(pkg.packageName).toBe("@teaspill/harness-casdk");
    expect(typeof pkg.createCasdkHarness).toBe("function");
    expect(typeof pkg.createFileSessionStore).toBe("function");
    expect(typeof pkg.createMemorySessionStore).toBe("function");
    expect(typeof pkg.createClaudeAgentSdkClient).toBe("function");
    expect(typeof pkg.projectCanonicalToSession).toBe("function");
    expect(typeof pkg.getTranslation).toBe("function");
    expect(pkg.PINNED_SDK_VERSION).toBe("0.3.211");
  });
});
