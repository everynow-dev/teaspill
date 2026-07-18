/**
 * @teaspill/harness-native — the harness interface (0001:T3.1), the platform
 * tools (0001:T3.3), and the pi-ai step-durable loop implementation (0001:T3.2).
 *
 * `./interface.js` + `./context.js` are the dependency-light contract modules
 * that `@teaspill/harness-casdk` and `@teaspill/agents-sdk` import (FROZEN
 * with the 0001:T0.1 schema at gate 0001:G3 — DECISIONS 0001:A5). The pi modules add the
 * native harness on top: `pi-harness.js` (the owned step-durable loop, with
 * injected `HarnessCtx`/`PiStepClient` seams), `pi-client.js` (the step
 * client seam + provider-error classification), `pi-context.js` (pure
 * canonical→provider assembly), `pi-provider.js` (the real
 * `@mariozechner/pi-ai` client).
 */

export * from "./interface.js";
export * from "./context.js";
export * from "./tools.js";
export * from "./workspace-tools.js";
export * from "./pi-client.js";
export * from "./pi-context.js";
export * from "./pi-harness.js";
export * from "./pi-provider.js";
