/**
 * The reference executor-host service (0002:T4.1) — the 0001:D4
 * developer-deployed executor plane, co-located shape (0001:T4.1
 * endpoint.ts): ONE process binds the `workspace/<key>` virtual object AND
 * the `executor-host` service, with the workspace object reaching the host
 * in-process (`createDirectHostClient` — every host method is idempotent by
 * design, so at-least-once `ctx.run` dispatch is safe).
 *
 *  - **Docker adapter** (0001:T4.2, hardened by 0002:T5.2): container per
 *    workspace, digest-pinned default image, per-workspace `network` policy.
 *    The service mounts the host Docker socket (root-equivalent — dev/self-
 *    host trust boundary; see docs/self-hosting.md "Executor & the Docker
 *    socket").
 *  - **Awakeable resolution** over Restate ingress
 *    (`createIngressAwakeableResolver`) — the long-exec protocol's completion
 *    path (SPIKE §d).
 *  - **Out-of-band exec output** to durable-streams via ./stream-sink.ts
 *    (best-effort telemetry, 0001:R4).
 */

import {
  createAdapterRegistry,
  createDirectHostClient,
  createExecutorEndpoint,
  createExecutorHostService,
  createIngressAwakeableResolver,
  createWorkspaceObject,
  ExecutorHost,
  type AdapterRegistryConfig,
} from "@teaspill/executor";
import { registerDeployment } from "@teaspill/agents-sdk";
import { createHealthProbe } from "@teaspill/cli/register";
import { createDurableStreamsSink } from "./stream-sink.js";
import { runBootstrapSequence, type BootstrapResult } from "./bootstrap.js";
import type { ServableEndpoint } from "./agent-loop.js";

export interface ExecutorHostConfig {
  /** Listen port. Default 9081. */
  port?: number;
  /** Restate ingress base url as seen from THIS process (awakeable resolve + kill path). */
  ingressUrl: string;
  /** durable-streams base url for the out-of-band exec-output sink. Absent ⇒ output drops (noop sink). */
  streamsUrl?: string;
  /** Gateway base url (health wait + registration). */
  gatewayUrl: string;
  /** The URL Restate dials (compose: `http://executor:9081`; host-run: `http://host.docker.internal:9081`). */
  deploymentUrl: string;
  /** Gateway API key for `/registry/*`. */
  apiKey?: string;
  /** Adapter registry config. Default: docker only, package defaults (0002:T5.2 hardened). */
  adapters?: AdapterRegistryConfig;
  logger?: (line: string) => void;
}

export interface ExecutorHostBuild {
  /** Structural endpoint view — see agent-loop.ts `ServableEndpoint`. */
  endpoint: ServableEndpoint;
  host: ExecutorHost;
}

export function buildExecutorHost(cfg: ExecutorHostConfig): ExecutorHostBuild {
  const host = new ExecutorHost({
    adapters: createAdapterRegistry(cfg.adapters ?? { docker: {} }),
    resolveAwakeable: createIngressAwakeableResolver({ ingressUrl: cfg.ingressUrl }),
    ...(cfg.streamsUrl !== undefined && {
      streamSink: createDurableStreamsSink({ baseUrl: cfg.streamsUrl }),
    }),
  });
  const workspace = createWorkspaceObject({ host: createDirectHostClient(host) });
  const endpoint = createExecutorEndpoint({ workspace, host: createExecutorHostService(host) });
  return { endpoint, host };
}

/** Serve + register (same load-bearing order as the agent-loop; no reconcilers here). */
export async function startExecutorHost(cfg: ExecutorHostConfig): Promise<BootstrapResult> {
  const log = cfg.logger ?? ((line: string) => console.error(line));
  const build = buildExecutorHost(cfg);
  const port = cfg.port ?? 9081;

  return runBootstrapSequence(
    {
      listen: async () => (await build.endpoint.listen(port)) ?? port,
      healthProbe: createHealthProbe(cfg.gatewayUrl),
      register: async () => {
        await registerDeployment({
          gatewayUrl: cfg.gatewayUrl,
          deploymentUrl: cfg.deploymentUrl,
          ...(cfg.apiKey !== undefined && { apiKey: cfg.apiKey }),
          agents: [], // executor deployment serves no agent types
        });
      },
    },
    { logger: log },
  );
}
