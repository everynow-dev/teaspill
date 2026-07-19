/**
 * The reference agent-loop service (0002:T4.1) — the 0001:D4
 * developer-deployed plane, assembled entirely from public package APIs. This
 * is the canonical "how do I stand up an agent-loop" example:
 *
 *  - REAL projection outbox: `DurableStreamsProjectionOutbox` over
 *    `HttpTimelineStreamTransport` (0001:D3), with the Drizzle catalog writer
 *    when a database is wired (0001:D1);
 *  - REAL notifier / directory / archive catalog (0001:T2.3, 0001:D7 —
 *    archived entities resurrect);
 *  - the four deterministic conformance agents (./conformance-agents.ts) +
 *    the env-gated demo agents (./demo-agents.ts), every inbound message
 *    normalized through ./loose-message.ts;
 *  - the drift reconciler object BOUND on the same endpoint (0002:T2.1
 *    handlers live on the agent objects; the reconciler partition object
 *    lives here because this deployment owns the catalog + agent seams) —
 *    the endpoint is built with `createCoordinationEndpoint({ agents,
 *    reconciler })` directly (agents-sdk `serve()` does not yet take a
 *    reconciler binding; noted in the WORKLOG);
 *  - loose-message normalization is layered onto each definition's compiled
 *    config via the `validateMessage` seam (compileConfig → patch →
 *    `createAgentObject`).
 *
 * `main` (./agent-loop-main.ts) wires env → build → bootstrap sequence
 * (listen → gateway-health wait → register → `scheduleReconcilers`, 0002:T2.2).
 */

import { registerDeployment, type AgentDefinition, type CompileDeps } from "@teaspill/agents-sdk";
import {
  createAgentNotifier,
  createAgentObject,
  createCoordinationEndpoint,
  createHttpSteerSource,
  createDrizzleArchiveCatalog,
  createDrizzleCatalogSampler,
  createDrizzleEntityDirectory,
  createDrizzleOutboxCatalog,
  createHttpReconcilerScheduleClient,
  createReconcilerAlertSink,
  createReconcilerObject,
  createRestateEntityReconcileClient,
  scheduleReconcilers,
  DurableStreamsProjectionOutbox,
  HttpTimelineStreamTransport,
  type AgentObject,
  type ReconcilerObject,
} from "@teaspill/coordination";
import type { CatalogDb } from "@teaspill/catalog";
import type { WorkspaceEnsureConfig } from "@teaspill/executor";
import { toolIdempotencyKey } from "@teaspill/harness-native";
import { privateWorkspaceKey } from "@teaspill/schema";
import { createHealthProbe } from "@teaspill/cli/register";
import { conformanceAgents } from "./conformance-agents.js";
import { buildDemoAgents } from "./demo-agents.js";
import { createDrizzleChildrenStore } from "./children.js";
import { createDeltaEmitterFactory } from "./delta-sink.js";
import { createReferenceToolContext } from "./tool-context.js";
import { createIngressWorkspaceClient } from "./workspace-client.js";
import { normalizeLooseMessage } from "./loose-message.js";
import { runBootstrapSequence, type BootstrapResult } from "./bootstrap.js";

export interface AgentLoopConfig {
  /** Listen port. Default 9080. */
  port?: number;
  /** Deployment tenant. Default `"default"`. */
  tenant?: string;
  /** Restate ingress base url as seen from THIS process (e.g. `http://restate:8080`). */
  ingressUrl: string;
  /** durable-streams base url as seen from THIS process (e.g. `http://durable-streams:4437`). */
  streamsUrl: string;
  /** Gateway base url (health wait + registration). */
  gatewayUrl: string;
  /**
   * The deployment URL Restate DIALS (work/plans/0001-build-v1/notes/self-hosting-networking.md §3):
   * compose service name in-network (`http://agent-loop:9080`), or
   * `http://host.docker.internal:<port>` for a host-run process — NEVER
   * localhost.
   */
  deploymentUrl: string;
  /** Gateway API key for `/registry/*` (0001:D6 — writes are key-authed). */
  apiKey?: string;
  /**
   * Drizzle catalog client. Absent ⇒ DEGRADED (loudly logged): no catalog
   * projection rows, no resurrection, no reconciler, `listChildren` empty.
   */
  db?: CatalogDb;
  /** Workspace adapter the private workspaces `ensure` with. Default `"docker"`. */
  workspaceAdapter?: string;
  /** Reconciler scheduling (0002:T2.2 opt-in). Default true when `db` is wired. */
  reconcilerEnabled?: boolean;
  /** Demo-agent gating. */
  anthropicApiKey?: string;
  demoCasdkEnabled?: boolean;
  demoModel?: string;
  casdkSessionDir?: string;
  /** Idle auto-archive delay override, ms (0001:A10 default 30 min; `0` disables). */
  idleArchiveDelayMs?: number;
  logger?: (line: string) => void;
}

/**
 * Minimal structural view of a served Restate endpoint. The SDK's fluent
 * endpoint type is deliberately NOT re-exported here: materializing it in
 * this package's declaration emit blows up tsc (it is a deeply-generic
 * builder type); `listen` is the only member a deployment needs.
 */
export interface ServableEndpoint {
  listen(port?: number): Promise<number | undefined>;
}

export interface AgentLoopBuild {
  /** The Restate endpoint (caller listens). */
  endpoint: ServableEndpoint;
  definitions: AgentDefinition[];
  objects: AgentObject[];
  reconciler: ReconcilerObject | null;
  skipped: Array<{ type: string; reason: string }>;
}

/**
 * Compile a definition with the deployment's loose-message normalization
 * layered under any definition-level validator (the `validateMessage`
 * NORMALIZE seam, 0001:T6.1) — additive use of coordination's public API.
 */
export function compileLooseConfig(
  def: AgentDefinition,
  deps: CompileDeps,
): ReturnType<AgentDefinition["compileConfig"]> {
  const config = def.compileConfig(deps);
  const inner = config.validateMessage;
  config.validateMessage = (input) => {
    const normalized = normalizeLooseMessage(input);
    return inner ? inner(normalized) : normalized;
  };
  return config;
}

export function compileWithLooseMessages(def: AgentDefinition, deps: CompileDeps): AgentObject {
  return createAgentObject(compileLooseConfig(def, deps));
}

export function buildAgentLoop(cfg: AgentLoopConfig): AgentLoopBuild {
  const log = cfg.logger ?? ((line: string) => console.error(line));
  const tenant = cfg.tenant ?? "default";
  const adapter = cfg.workspaceAdapter ?? "docker";
  const ensure: WorkspaceEnsureConfig = { adapter };

  // --- deployment seams (CompileDeps) --------------------------------------
  const outbox = new DurableStreamsProjectionOutbox({
    transport: new HttpTimelineStreamTransport({ baseUrl: cfg.streamsUrl }),
    ...(cfg.db !== undefined && { catalog: createDrizzleOutboxCatalog(cfg.db) }),
  });
  const deps: CompileDeps = {
    outbox,
    notifier: createAgentNotifier(),
    tenant,
    ...(cfg.db !== undefined && {
      directory: createDrizzleEntityDirectory(cfg.db),
      archiveCatalog: createDrizzleArchiveCatalog(cfg.db),
    }),
  };
  if (cfg.db === undefined) {
    log(
      "[agent-loop] DEGRADED: no database wired (DATABASE_URL unset) — no catalog rows, " +
        "no resurrection, no reconciler, listChildren always empty",
    );
  }

  // --- tool clients (the 0001:T6.2 seams, real) ----------------------------
  const children = cfg.db !== undefined ? createDrizzleChildrenStore(cfg.db) : undefined;
  const toolContext = createReferenceToolContext({
    ingressUrl: cfg.ingressUrl,
    ...(children !== undefined && { children }),
    workspace: { ensure },
  });

  // --- agents --------------------------------------------------------------
  const definitions: AgentDefinition[] = conformanceAgents({
    tenant,
    workspaceExec: (bind) =>
      createIngressWorkspaceClient({
        ingressUrl: cfg.ingressUrl,
        // Spawn-chosen workspace (0001:D4, via OnWakeContext.workspaceRef —
        // 0002:T4.2) wins; derived private workspace is the default.
        workspaceRef: bind.workspaceRef ?? privateWorkspaceKey(bind.entityUrl),
        ensure,
        // Wake-scoped exactly-once key (0001:T3.1 pattern; "on-wake-exec"
        // stands in for the toolUseId this non-tool path doesn't have).
        idempotencyKey: toolIdempotencyKey(bind.entityUrl, bind.runId, "on-wake-exec"),
      }),
  });
  const demo = buildDemoAgents({
    toolContext,
    ...(cfg.anthropicApiKey !== undefined && { anthropicApiKey: cfg.anthropicApiKey }),
    ...(cfg.demoCasdkEnabled !== undefined && { casdkEnabled: cfg.demoCasdkEnabled }),
    ...(cfg.demoModel !== undefined && { model: cfg.demoModel }),
    ...(cfg.casdkSessionDir !== undefined && { casdkSessionDir: cfg.casdkSessionDir }),
  });
  definitions.push(...demo.definitions);
  for (const skip of demo.skipped) {
    log(`[agent-loop] demo agent ${skip.type} not served: ${skip.reason}`);
  }

  // Per-entity seams (0002:T4.2 — the additive factories closing 0002:T4.1's
  // flags): the steerbox drain keyed by the entity url, and the best-effort
  // `/deltas` emitter stamping entityId. Definition-level factories win.
  const steerSourceFactory = ({ entityId }: { entityId: string }) =>
    createHttpSteerSource({ ingressUrl: cfg.ingressUrl, entityId });
  const emitDeltaFactory = createDeltaEmitterFactory({
    streamsUrl: cfg.streamsUrl,
    onDrop: (err) => log(`[agent-loop] delta dropped: ${String(err)}`),
  });
  const objects = definitions.map((def) => {
    const config = compileLooseConfig(def, deps);
    config.steerSourceFactory ??= steerSourceFactory;
    config.emitDeltaFactory ??= emitDeltaFactory;
    if (cfg.idleArchiveDelayMs !== undefined) config.idleArchiveDelayMs ??= cfg.idleArchiveDelayMs;
    return createAgentObject(config);
  });

  // --- reconciler object (0002:T2.2 — bound here, scheduled post-register) --
  const reconciler =
    cfg.db !== undefined
      ? createReconcilerObject({
          deps: {
            sampler: createDrizzleCatalogSampler(cfg.db),
            client: createRestateEntityReconcileClient(),
            catalog: createDrizzleOutboxCatalog(cfg.db),
            alert: createReconcilerAlertSink(),
          },
        })
      : null;

  const endpoint = createCoordinationEndpoint({
    agents: objects,
    ...(reconciler !== null && { reconciler }),
  });

  return { endpoint, definitions, objects, reconciler, skipped: demo.skipped };
}

/**
 * Serve + register + schedule (the 0002:T2.2 bootstrap): listen → wait on
 * gateway health → register through the gateway with backoff →
 * `scheduleReconcilers` against Restate ingress (generation-guarded, no-op
 * when disabled). Returns once fully up.
 */
export async function startAgentLoop(cfg: AgentLoopConfig): Promise<BootstrapResult> {
  const log = cfg.logger ?? ((line: string) => console.error(line));
  const build = buildAgentLoop(cfg);
  const port = cfg.port ?? 9080;
  const reconcilerEnabled = cfg.reconcilerEnabled ?? build.reconciler !== null;

  return runBootstrapSequence(
    {
      listen: async () => (await build.endpoint.listen(port)) ?? port,
      healthProbe: createHealthProbe(cfg.gatewayUrl),
      register: async () => {
        await registerDeployment({
          gatewayUrl: cfg.gatewayUrl,
          deploymentUrl: cfg.deploymentUrl,
          ...(cfg.apiKey !== undefined && { apiKey: cfg.apiKey }),
          agents: build.definitions,
        });
      },
      schedule: async () => {
        // 0002:T2.2's compose-adjacent bootstrap hook — THE call 0002:T4.1
        // exists to place. Idempotent by generation supersession; a logged
        // no-op unless enabled.
        await scheduleReconcilers({
          client: createHttpReconcilerScheduleClient({ ingressUrl: cfg.ingressUrl }),
          enabled: reconcilerEnabled && build.reconciler !== null,
          logger: log,
        });
      },
    },
    { logger: log },
  );
}
