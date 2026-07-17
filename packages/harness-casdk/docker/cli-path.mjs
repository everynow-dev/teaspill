/**
 * Resolves the filesystem path to the bundled CASDK CLI subprocess binary
 * (T7.3 packaging).
 *
 * `@anthropic-ai/claude-agent-sdk` (pinned 0.3.211, bundled CLI 2.1.211 —
 * see ../README.md) ships the real `claude` executable as a set of
 * platform-gated `optionalDependencies`
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`); npm/pnpm
 * installs only the variant matching the CURRENT install-time platform. This
 * resolves to that installed variant so docker/healthcheck.mjs and
 * docker/entrypoint.mjs can boot-probe it directly, independent of the SDK's
 * own (lazy, subprocess-spawning) internals.
 *
 * Resolution deliberately goes through the SDK's OWN module graph
 * (`createRequire` anchored at its resolved entry file), not the caller's:
 * under pnpm's strict node_modules linking, a platform binary package (an
 * optional dependency of `@anthropic-ai/claude-agent-sdk`, not a direct
 * dependency of this script or of `@teaspill/harness-casdk` itself) is only
 * resolvable from inside that package's own module graph.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const requireFromHere = createRequire(import.meta.url);

function platformPackageName() {
  const { platform, arch } = process;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error(`resolveClaudeCliPath: unsupported platform ${JSON.stringify(platform)}`);
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`resolveClaudeCliPath: unsupported arch ${JSON.stringify(arch)}`);
  }
  let suffix = "";
  if (platform === "linux") {
    // This image's base (node:22-slim, Debian) is glibc. Only append -musl
    // when actually running on a musl libc target (e.g. an Alpine-based
    // image swap) — `process.report`'s glibc header is present iff glibc.
    const report = process.report?.getReport?.();
    const isGlibc = Boolean(report?.header?.glibcVersionRuntime);
    if (!isGlibc) suffix = "-musl";
  }
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${suffix}`;
}

/** @returns {string} absolute path to the installed `claude` CLI binary. */
export function resolveClaudeCliPath() {
  const sdkEntry = requireFromHere.resolve("@anthropic-ai/claude-agent-sdk");
  const sdkRequire = createRequire(join(dirname(sdkEntry), "package.json"));
  const pkg = platformPackageName();
  const binName = process.platform === "win32" ? "claude.exe" : "claude";
  return sdkRequire.resolve(`${pkg}/${binName}`);
}
