import { describe, expect, it } from "vitest";
import * as core from "./index.js";

describe("@teaspill/frontend-sdk", () => {
  it("exposes the framework-agnostic core (no React import required)", () => {
    expect(typeof core.createAgentTimeline).toBe("function");
    expect(typeof core.createAgentCatalog).toBe("function");
    expect(typeof core.createActionsClient).toBe("function");
    expect(typeof core.initialTimelineState).toBe("function");
    expect(typeof core.applyTimelineEvent).toBe("function");
    expect(typeof core.applyDeltaRecord).toBe("function");
    // A7 fast-join planning helpers re-exported from the frozen schema.
    expect(typeof core.selectFastJoinSnapshot).toBe("function");
    expect(typeof core.fastJoinFromSeq).toBe("function");
    expect(typeof core.checkSeqContiguity).toBe("function");
  });

  it("core modules never import react", async () => {
    // The react bindings are a separate entry (`./react`); requiring the core
    // must not touch the optional peer. This would have thrown at import time
    // if any core module imported react, but assert the export surface too.
    expect(Object.keys(core)).not.toContain("useAgentTimeline");
    expect(Object.keys(core)).not.toContain("useAgentCatalog");
  });
});
