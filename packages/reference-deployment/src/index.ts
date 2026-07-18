/**
 * @teaspill/reference-deployment (0002:T4.1) — the canonical deployable
 * reference: agent-loop + executor-host services for the compose overlay
 * (`docker-compose.overlay.yml`), the deterministic onWake conformance
 * agents, env-gated demo agents, and the REAL deployment-side seams
 * 0001:T6.2 left open (concrete ingress `WorkspaceClient`, real ingress tool
 * clients, `listChildren`). See README.md for the getting-started guide.
 */

export const packageName = "@teaspill/reference-deployment" as const;

export { normalizeLooseMessage } from "./loose-message.js";
export { onWakeOnlyHarness, ON_WAKE_ONLY_HANDOFF_ERROR } from "./on-wake-harness.js";
export {
  createIngressWorkspaceClient,
  deriveExecId,
  type IngressWorkspaceClientOptions,
} from "./workspace-client.js";
export {
  createDrizzleChildrenStore,
  createMemoryChildrenStore,
  type ChildRow,
  type ChildrenStore,
} from "./children.js";
export {
  createReferenceToolContext,
  type ReferenceToolContextOptions,
} from "./tool-context.js";
export {
  conformanceAgents,
  echoAgent,
  fanoutChildAgent,
  fanoutParentAgent,
  longExecAgent,
  lastUserJson,
  lastUserText,
  sanitizeInstanceId,
  CONFORMANCE_TYPES,
  type ConformanceAgentDeps,
} from "./conformance-agents.js";
export { buildDemoAgents, DEMO_TYPES, type DemoAgentOptions, type DemoAgentsBuild } from "./demo-agents.js";
export { createDurableStreamsSink, type DurableStreamsSinkOptions } from "./stream-sink.js";
export { runBootstrapSequence, type BootstrapOptions, type BootstrapResult, type BootstrapSteps } from "./bootstrap.js";
export {
  buildAgentLoop,
  compileLooseConfig,
  compileWithLooseMessages,
  startAgentLoop,
  type AgentLoopBuild,
  type AgentLoopConfig,
  type ServableEndpoint,
} from "./agent-loop.js";
export {
  buildExecutorHost,
  startExecutorHost,
  type ExecutorHostBuild,
  type ExecutorHostConfig,
} from "./executor-host.js";
export {
  readAgentLoopEnv,
  readExecutorEnv,
  type AgentLoopEnv,
  type CommonServiceEnv,
  type ExecutorEnv,
} from "./env.js";
