#!/usr/bin/env node
/**
 * Docker HEALTHCHECK for the CASDK harness runtime image (T7.3, PLAN.md
 * Phase 7: "healthcheck that verifies the CLI boots"). Also run once at
 * IMAGE BUILD time (see ../Dockerfile) so a broken/missing CLI binary fails
 * the build, not the first container boot — mirrors the gateway image's
 * `GATEWAY_SMOKE` build-time smoke run (packages/gateway/Dockerfile).
 *
 * Scope, deliberately narrow: this verifies the bundled CASDK CLI subprocess
 * itself boots (`claude --version` exits 0) — the packaging-level invariant
 * T7.3 owns. It is NOT a check that a deployed `defineAgent(...)` app is
 * registered with the gateway or is serving Restate invocations; that is
 * the app's own liveness surface (see PACKAGING.md).
 */
import { execFileSync } from "node:child_process";
import { resolveClaudeCliPath } from "./cli-path.mjs";

try {
  const bin = resolveClaudeCliPath();
  const out = execFileSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (!out.trim()) throw new Error("claude --version produced no output");
  process.stdout.write(`casdk cli boot probe OK: ${out.trim()} (${bin})\n`);
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`casdk cli boot probe FAILED: ${msg}\n`);
  process.exit(1);
}
