/**
 * @teaspill/agents-sdk — the developer-facing Agents SDK (T6.1).
 *
 * `defineAgent(...)` compiles a typed agent definition (spawn/inbox/state
 * schemas, harness selection, tools) onto the coordination agent-object
 * template (D2); `native(...)`/`claudeAgentSdk(...)` are the D5 harness-
 * selection seam; `serve(...)`/`registerDeployment(...)` stand up the Restate
 * endpoint and register it through the gateway; the revision helpers enforce
 * the additive-only state-schema rule.
 */

export const packageName = "@teaspill/agents-sdk" as const;

// T6.1 — defineAgent + harness selection + serve/register + revisioning.
export {
  defineAgent,
  type AgentDefinition,
  type AgentRegistration,
  type CompileDeps,
  type DefineAgentInput,
  type OnWakeHook,
  type OnWakeInfo,
} from "./define-agent.js";
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

// T1.4 — optional JWT read path: developers mint short-lived read tokens so
// browsers can read /streams/* and /shapes/* directly (D6). See read-token.ts.
export {
  mintReadToken,
  type MintReadTokenOptions,
  type ReadTokenClaims,
} from "./read-token.js";
