/**
 * `local-unrestricted` adapter (T4.2) — the guard (required opt-in) and that it
 * otherwise delivers the same real-process/real-FS conformance as `local`
 * (reused implementation). The exhaustive exec/FS/containment coverage lives in
 * local-adapter.test.ts; here we assert the T4.2 additions: the gate, the name,
 * and that a gated instance still runs the flow end to end.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceError } from "./errors.js";
import {
  createLocalUnrestrictedAdapter,
  LOCAL_UNRESTRICTED_ENV_GATE,
} from "./local-unrestricted-adapter.js";

const WS_KEY = "default/t42-lu";

describe("local-unrestricted adapter", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "teaspill-lu-"));
    delete process.env[LOCAL_UNRESTRICTED_ENV_GATE];
  });
  afterEach(async () => {
    delete process.env[LOCAL_UNRESTRICTED_ENV_GATE];
    await rm(base, { recursive: true, force: true });
  });

  it("REFUSES to construct without an explicit opt-in (can't be enabled by accident)", () => {
    expect(() => createLocalUnrestrictedAdapter({ baseDir: base })).toThrow(WorkspaceError);
    expect(() => createLocalUnrestrictedAdapter({ baseDir: base })).toThrow(/refused|opt in/i);
  });

  it("constructs with the in-code opt-in flag", () => {
    const adapter = createLocalUnrestrictedAdapter({ baseDir: base, allowUnrestricted: true, quiet: true });
    expect(adapter.name).toBe("local-unrestricted");
    expect(adapter.readContainment).toBe("workspace");
  });

  it("constructs with the env gate", () => {
    process.env[LOCAL_UNRESTRICTED_ENV_GATE] = "1";
    const adapter = createLocalUnrestrictedAdapter({ baseDir: base, quiet: true });
    expect(adapter.name).toBe("local-unrestricted");
  });

  it("delivers ExecutorAdapter conformance (real exec + FS round-trip, contained)", async () => {
    const adapter = createLocalUnrestrictedAdapter({ baseDir: base, allowUnrestricted: true, quiet: true });
    const env = await adapter.ensure({ workspaceKey: WS_KEY, config: { adapter: "local-unrestricted" } });

    const done = await env
      .startExec({ execId: "e1", command: "printf hi", timeoutMs: 10_000, maxTailBytes: 4096 })
      .wait();
    expect(done.exitCode).toBe(0);
    expect(done.tail.stdout).toBe("hi");

    await env.writeFile("f.txt", "body");
    expect((await env.readFile("f.txt")).content).toBe("body");
    await expect(env.writeFile("../escape.txt", "x")).rejects.toMatchObject({ kind: "policy" });
  });
});
