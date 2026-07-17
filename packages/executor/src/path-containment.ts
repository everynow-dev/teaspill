/**
 * Path containment (T4.1 anticipate-b) — THE one module every adapter routes
 * its filesystem paths through. Ported from electric's sandbox layer rather
 * than reinvented (PLAN §8.2):
 *
 * - String-level containment (`absoluteWorkspacePath`, `isPathWithinWorkspace`,
 *   `containWorkspacePath`) ← `../electric/packages/agents-runtime/src/sandbox/path-containment.ts`.
 *   For ISOLATED adapters (docker/remote, T4.2): paths name locations inside
 *   the container/VM, so resolution is always POSIX and the container root is
 *   the real isolation boundary — an in-sandbox symlink escaping the workspace
 *   is not separately rejected there.
 * - Realpath symlink-walking containment (`resolveContainedPath`) ←
 *   `../electric/packages/agents-runtime/src/sandbox/unrestricted.ts#resolveWithin`.
 *   For HOST-FS-SHARING adapters (the dev `local` adapter): realpath
 *   resolution is the ONLY boundary, so every component is canonicalized
 *   (following symlinks) before the containment check — this defends against
 *   the CVE-2025-53109/53110-shape bypass where the path string looks clean
 *   but a component is a symlink pointing outside the workspace.
 *
 * ## Containment rules (the cross-adapter contract, per electric's docs)
 *
 * - WRITES (`write`, `mkdir`, `rm`) are contained on EVERY adapter: a path
 *   resolving outside the workspace root rejects with `WorkspaceError('policy')`.
 * - READS (`read`, `stat`, `ls`) are contained on `local` and `docker`;
 *   a future `remote` (VM) adapter may allow reads anywhere in the VM (system
 *   binaries live outside the workspace and the VM is already isolated).
 *   Each adapter documents its stance (see `ExecutorAdapter.readContainment`).
 * - SYMLINK escapes are followed-and-rejected only by host-FS-sharing
 *   adapters (`resolveContainedPath`); isolated adapters use the string
 *   check and rely on the container/VM root.
 */

import { dirname, relative, resolve, posix } from "node:path";
import { realpath } from "node:fs/promises";
import { WorkspaceError } from "./errors.js";

// ---------------------------------------------------------------------------
// String-level containment (isolated adapters — docker/remote, T4.2)
// ---------------------------------------------------------------------------

/**
 * Assert an isolated adapter's workspace root is an absolute POSIX path.
 * Call once at adapter/environment construction: a relative or non-POSIX
 * root would silently `posix.resolve` against the host cwd below — fail
 * loudly instead. (Port of electric's `assertAbsolutePosixWorkingDirectory`.)
 */
export function assertAbsolutePosixRoot(root: string): void {
  if (!posix.isAbsolute(root)) {
    throw new WorkspaceError(
      "policy",
      `workspace root must be an absolute POSIX path, got: ${JSON.stringify(root)}`,
    );
  }
}

/** Resolve a user-supplied path against the workspace root to an absolute POSIX path. */
export function absoluteWorkspacePath(root: string, path: string): string {
  return path.startsWith("/") ? posix.normalize(path) : posix.resolve(root, path);
}

/**
 * Whether `path` resolves to a location inside `root` — the string-level
 * boundary isolated adapters enforce. NOT symlink-aware; do not use for a
 * host-FS-sharing adapter (use `resolveContainedPath`).
 */
export function isPathWithinWorkspace(root: string, path: string): boolean {
  const rel = posix.relative(root, absoluteWorkspacePath(root, path));
  return !rel.startsWith("..") && rel !== "..";
}

/**
 * Resolve-and-assert for isolated adapters: returns the absolute in-sandbox
 * path or throws `WorkspaceError('policy')`.
 */
export function containWorkspacePath(root: string, path: string): string {
  const abs = absoluteWorkspacePath(root, path);
  if (!isPathWithinWorkspace(root, abs)) {
    throw new WorkspaceError(
      "policy",
      `path ${JSON.stringify(path)} resolves outside the workspace root ${root}`,
    );
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Realpath symlink-walking containment (host-FS-sharing adapters — local)
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path against `root` and verify it stays inside,
 * FOLLOWING SYMLINKS (port of electric's `unrestricted.ts#resolveWithin`,
 * comments preserved where load-bearing):
 *
 * - For paths that already exist, returns the canonicalized realpath.
 * - For paths that don't yet exist (write/mkdir of a new file), walks up to
 *   the deepest existing ancestor, verifies ITS realpath is inside the
 *   workspace, and returns the canonical ancestor joined with the
 *   non-existing remainder — so the FS target can't be redirected by a
 *   symlink component mid-path.
 * - The workspace root itself is canonicalized first (a pure-string
 *   pre-check false-positives when the root sits under a symlink, e.g.
 *   macOS `/var` → `/private/var`).
 *
 * Known limitation carried over from the source (single-tenant trusted-code
 * contract): when the returned target includes not-yet-existing components
 * there is a narrow TOCTOU window — a concurrent writer could materialize an
 * escaping intermediate symlink between this check and the caller's FS op.
 * A multi-tenant use would need to re-validate after the FS call.
 *
 * Throws `WorkspaceError('policy')` if the resolved path escapes `root`.
 */
export async function resolveContainedPath(root: string, userPath: string): Promise<string> {
  const denied = (): WorkspaceError =>
    new WorkspaceError(
      "policy",
      `access to ${JSON.stringify(userPath)} is denied (outside workspace root ${root})`,
    );

  const rootReal = await realpath(root);
  let probe = resolve(root, userPath);
  let suffix = "";
  for (;;) {
    try {
      const real = await realpath(probe);
      const rel = relative(rootReal, real);
      if (rel.startsWith("..") || rel === "..") throw denied();
      return suffix.length === 0 ? real : resolve(real, suffix);
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      const parent = dirname(probe);
      if (parent === probe) throw denied();
      suffix =
        suffix.length === 0
          ? probe.slice(parent.length + 1)
          : `${probe.slice(parent.length + 1)}/${suffix}`;
      probe = parent;
    }
  }
}
