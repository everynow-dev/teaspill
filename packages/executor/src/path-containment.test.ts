/**
 * Path containment (0001:T4.1 anticipate-b) — the escape-attempt suite: `../`
 * traversal, absolute paths, symlink components, symlinked workspace roots.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceError } from "./errors.js";
import {
  absoluteWorkspacePath,
  assertAbsolutePosixRoot,
  containWorkspacePath,
  isPathWithinWorkspace,
  resolveContainedPath,
} from "./path-containment.js";

// ---------------------------------------------------------------------------
// String-level containment (isolated adapters — docker/remote, 0001:T4.2)
// ---------------------------------------------------------------------------

describe("string-level containment (isolated adapters)", () => {
  const ROOT = "/workspace";

  it("accepts relative paths resolving inside the root", () => {
    expect(isPathWithinWorkspace(ROOT, "file.txt")).toBe(true);
    expect(isPathWithinWorkspace(ROOT, "sub/dir/file.txt")).toBe(true);
    expect(isPathWithinWorkspace(ROOT, ".")).toBe(true);
    expect(isPathWithinWorkspace(ROOT, "sub/../other")).toBe(true);
  });

  it("accepts absolute paths inside the root", () => {
    expect(isPathWithinWorkspace(ROOT, "/workspace/file.txt")).toBe(true);
    expect(isPathWithinWorkspace(ROOT, "/workspace")).toBe(true);
  });

  it("rejects `..` traversal escaping the root", () => {
    expect(isPathWithinWorkspace(ROOT, "..")).toBe(false);
    expect(isPathWithinWorkspace(ROOT, "../etc/passwd")).toBe(false);
    expect(isPathWithinWorkspace(ROOT, "sub/../../outside")).toBe(false);
  });

  it("rejects absolute paths outside the root", () => {
    expect(isPathWithinWorkspace(ROOT, "/etc/passwd")).toBe(false);
    // Prefix trickery: /workspace-evil shares the string prefix but is a sibling.
    expect(isPathWithinWorkspace(ROOT, "/workspace-evil/file")).toBe(false);
  });

  it("containWorkspacePath returns the resolved path or throws policy", () => {
    expect(containWorkspacePath(ROOT, "a/b.txt")).toBe("/workspace/a/b.txt");
    expect(() => containWorkspacePath(ROOT, "../escape")).toThrowError(WorkspaceError);
    try {
      containWorkspacePath(ROOT, "../escape");
    } catch (err) {
      expect((err as WorkspaceError).kind).toBe("policy");
    }
  });

  it("normalizes absolute paths with traversal segments before checking", () => {
    expect(isPathWithinWorkspace(ROOT, "/workspace/sub/../../etc")).toBe(false);
    expect(absoluteWorkspacePath(ROOT, "/workspace/sub/../ok")).toBe("/workspace/ok");
  });

  it("assertAbsolutePosixRoot rejects relative roots loudly", () => {
    expect(() => assertAbsolutePosixRoot("relative/dir")).toThrowError(WorkspaceError);
    expect(() => assertAbsolutePosixRoot("/abs/dir")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Realpath symlink-walking containment (host-FS-sharing adapters — local)
// ---------------------------------------------------------------------------

describe("resolveContainedPath (realpath/symlink walk)", () => {
  let base: string; // scratch area
  let root: string; // the workspace root
  let outside: string; // sibling dir OUTSIDE the root

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "teaspill-containment-"));
    root = join(base, "ws");
    outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside");
    await writeFile(join(root, "inside.txt"), "inside");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const expectPolicy = async (p: Promise<unknown>): Promise<void> => {
    await expect(p).rejects.toThrowError(WorkspaceError);
    await p.catch((err) => expect((err as WorkspaceError).kind).toBe("policy"));
  };

  it("resolves existing in-root paths to their realpath", async () => {
    const resolvedPath = await resolveContainedPath(root, "inside.txt");
    expect(resolvedPath).toBe(join(await realpath(root), "inside.txt"));
  });

  it("resolves not-yet-existing paths under an existing in-root ancestor (write/mkdir case)", async () => {
    const target = await resolveContainedPath(root, "new-dir/new-file.txt");
    expect(target).toBe(join(await realpath(root), "new-dir/new-file.txt"));
  });

  it("rejects `..` traversal", async () => {
    await expectPolicy(resolveContainedPath(root, "../outside/secret.txt"));
    await expectPolicy(resolveContainedPath(root, "a/../../outside/secret.txt"));
    await expectPolicy(resolveContainedPath(root, ".."));
  });

  it("rejects absolute paths outside the root", async () => {
    await expectPolicy(resolveContainedPath(root, join(outside, "secret.txt")));
    await expectPolicy(resolveContainedPath(root, "/etc/passwd"));
  });

  it("rejects a symlinked DIRECTORY component pointing outside (CVE-2025-53109/53110 shape)", async () => {
    await symlink(outside, join(root, "sneaky-dir"));
    await expectPolicy(resolveContainedPath(root, "sneaky-dir/secret.txt"));
    // …including for a file that does not exist yet (write-through-symlink)
    await expectPolicy(resolveContainedPath(root, "sneaky-dir/new-file.txt"));
  });

  it("rejects a symlinked FILE pointing outside", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "sneaky-file"));
    await expectPolicy(resolveContainedPath(root, "sneaky-file"));
  });

  it("allows in-root symlinks pointing at in-root targets", async () => {
    await symlink(join(root, "inside.txt"), join(root, "alias.txt"));
    const target = await resolveContainedPath(root, "alias.txt");
    expect(target).toBe(join(await realpath(root), "inside.txt"));
  });

  it("does not false-positive when the workspace ROOT itself sits under a symlink (macOS /var shape)", async () => {
    const aliasRoot = join(base, "ws-alias");
    await symlink(root, aliasRoot);
    // Access THROUGH the alias: a naive string check against the alias root
    // would reject the realpath'd target; the canonicalized-root walk accepts.
    const target = await resolveContainedPath(aliasRoot, "inside.txt");
    expect(target).toBe(join(await realpath(root), "inside.txt"));
    // …and escapes are still escapes through the alias.
    await expectPolicy(resolveContainedPath(aliasRoot, "../outside/secret.txt"));
  });

  it("rejects fully non-existent escape paths (deepest-ancestor check)", async () => {
    await expectPolicy(resolveContainedPath(root, "../nowhere/at/all.txt"));
  });
});
