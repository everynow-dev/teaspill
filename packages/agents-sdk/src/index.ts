/**
 * @teaspill/agents-sdk — the developer-facing Agents SDK (0001:T6.1).
 *
 * `defineAgent(...)` compiles a typed agent definition (spawn/inbox/state
 * schemas, harness selection, tools) onto the coordination agent-object
 * template (0001:D2); `native(...)`/`claudeAgentSdk(...)` are the 0001:D5 harness-
 * selection seam; `serve(...)`/`registerDeployment(...)` stand up the Restate
 * endpoint and register it through the gateway; the revision helpers enforce
 * the additive-only state-schema rule.
 */

export const packageName = "@teaspill/agents-sdk" as const;

// 0001:T6.1 — defineAgent + harness selection + serve/register + revisioning.
export {
  defineAgent,
  type AgentDefinition,
  type AgentRegistration,
  type CompileDeps,
  type DefineAgentInput,
  type OnWakeHook,
} from "./define-agent.js";

// 0001:T8.1 — the per-wake hook contract + archive-of-record seam are authored in
// coordination; re-export so developers write `onWake`/wire `archiveCatalog`
// straight off `@teaspill/agents-sdk`.
export {
  createDrizzleArchiveCatalog,
  type ArchiveCatalog,
  type OnWakeHandler,
  type OnWakeContext,
  type OnWakeOutcome,
} from "@teaspill/coordination";
export {
  native,
  claudeAgentSdk,
  httpToolContext,
  CASDK_NOT_AVAILABLE,
  type HarnessKind,
  type HarnessSelection,
  type HarnessSpec,
  type NativeHarnessConfig,
  type ClaudeAgentSdkConfig,
  type ToolContextBuilder,
  type HttpToolClientsOptions,
} from "./harness.js";
export {
  serve,
  registerDeployment,
  type ServeOptions,
  type ServeHandle,
  type RegisterDeploymentOptions,
  type RegisterDeploymentResult,
} from "./serve.js";
export {
  diffStateSchema,
  assertStateRevision,
  StateRevisionError,
  type StateSchemaDiff,
  type StateRevisionBaseline,
  type AssertStateRevisionInput,
} from "./revision.js";

// 0001:T1.4 — optional JWT read path: developers mint short-lived read tokens so
// browsers can read /streams/* and /shapes/* directly (0001:D6). See read-token.ts.
export {
  mintReadToken,
  type MintReadTokenOptions,
  type ReadTokenClaims,
} from "./read-token.js";
