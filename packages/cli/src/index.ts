#!/usr/bin/env node
/**
 * @teaspill/cli — the `teaspill` binary (0001:T6.2).
 *
 * `platform dev`/`dev`, `agents ls`, `spawn`, `send`, `control`, `logs` — a
 * thin consumer of the agents-SDK (serve/registerDeployment) and frontend-SDK
 * (actions/catalog/timeline). Arg parsing + dispatch live in `cli.ts`; the
 * command bodies in `commands/*`; everything reaches the outside world through
 * an injected `CliDeps` so the whole surface is testable without a live stack.
 */

export const packageName = "@teaspill/cli" as const;

export { run, buildCli } from "./cli.js";
export { createDefaultDeps, type CliDeps, type CliIO } from "./deps.js";
export { resolveConfig, type ResolvedConfig } from "./config.js";
export {
  waitForHealthy,
  retryWithBackoff,
  backoffDelay,
  createHealthProbe,
  GatewayUnhealthyError,
  type BackoffOptions,
} from "./register.js";
export { collectRenderable, renderNewLines, type RenderedLine } from "./render.js";

// Execute only when invoked as the `teaspill` bin, not on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { run } = await import("./cli.js");
  const code = await run();
  process.exit(code);
}
