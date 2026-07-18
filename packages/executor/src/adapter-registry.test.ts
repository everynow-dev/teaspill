/**
 * Adapter registry / selection (0001:T4.2) — builds only the configured adapters,
 * keyed by the names the executor host resolves `config.adapter` against.
 */

import { describe, expect, it } from "vitest";
import { createAdapter, createAdapterRegistry } from "./adapter-registry.js";
import { WorkspaceError } from "./errors.js";

describe("adapter registry", () => {
  it("builds only the configured adapters, keyed by adapter name", () => {
    const registry = createAdapterRegistry({
      local: { baseDir: "/tmp/x", quiet: true },
      localUnrestricted: { baseDir: "/tmp/y", allowUnrestricted: true, quiet: true },
      docker: { probeOnEnsure: false },
    });
    expect(Object.keys(registry).sort()).toEqual(["docker", "local", "local-unrestricted"]);
    expect(registry.local!.name).toBe("local");
    expect(registry["local-unrestricted"]!.name).toBe("local-unrestricted");
    expect(registry.docker!.name).toBe("docker");
  });

  it("omits adapters that are not configured (no accidental host execution)", () => {
    const registry = createAdapterRegistry({ docker: { probeOnEnsure: false } });
    expect(Object.keys(registry)).toEqual(["docker"]);
    expect(registry.local).toBeUndefined();
    expect(registry["local-unrestricted"]).toBeUndefined();
  });

  it("createAdapter selects a single adapter by name", () => {
    expect(createAdapter("local", { baseDir: "/tmp/x", quiet: true }).name).toBe("local");
    expect(createAdapter("docker", { probeOnEnsure: false }).name).toBe("docker");
  });

  it("propagates the local-unrestricted opt-in guard through the factory", () => {
    expect(() => createAdapterRegistry({ localUnrestricted: { baseDir: "/tmp/z" } })).toThrow(
      WorkspaceError,
    );
  });
});
