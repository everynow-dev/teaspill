/**
 * Deployment: stand up the Restate endpoint for a set of `defineAgent`
 * definitions and register it through the gateway on boot (0001:T6.1).
 *
 * `serve({ agents, deps, ... })` compiles each definition into its Restate
 * virtual object (wiring the deployment's real outbox/notifier seams), binds
 * them into the coordination endpoint (alongside cron + steerbox), listens, and
 * — when `registration` is given — POSTs the deployment URL to the gateway's
 * `/registry/deployments` (which forwards it to Restate's admin API AS-IS;
 * docs/self-hosting-networking.md §3: the URL must be reachable from inside the
 * `restate` container — `host.docker.internal:<port>` for host-run dev, NOT
 * `localhost`). The per-type **revision** rides along in the returned manifest.
 *
 * ## Contract note for 0001:T6.2
 *
 * `registerDeployment` does ONE attempt and throws on failure. **0001:T6.2 owns the
 * register-before-gateway-up race (retry/backoff + gateway-health wait)** — the
 * electric-agents "Stream not found on boot" class. `serve({ registration })`
 * calls it once; a CLI/dev loop should wrap it with backoff.
 */

import {
  createCoordinationEndpoint,
  type AgentObject,
} from "@teaspill/coordination";
import type { AgentDefinition, AgentRegistration, CompileDeps } from "./define-agent.js";

// ===========================================================================
// Registration (0001:T1.2 /registry/* → Restate admin)
// ===========================================================================

export interface RegisterDeploymentOptions {
  /** Gateway base url, e.g. `http://localhost:8081`. */
  gatewayUrl: string;
  /**
   * The deployment URL Restate will DIAL for every invocation (forwarded
   * as-is; no rewrite — 0001:T1.2). Compose service name on the network, or
   * `http://host.docker.internal:<port>` for host-run dev.
   */
  deploymentUrl: string;
  /** Gateway API key (server-side auth, 0001:D6). */
  apiKey?: string;
  /** The agent definitions being registered (for the returned manifest). */
  agents: readonly AgentDefinition[];
  /** Test/advanced seam: inject `fetch`. */
  fetch?: typeof fetch;
  /** Extra headers on the registration request. */
  headers?: Record<string, string>;
  /** Overwrite an existing deployment at this URI (Restate admin `force`). Default true. */
  force?: boolean;
}

export interface RegisterDeploymentResult {
  deploymentUrl: string;
  /** The revisioned manifest per agent type. */
  agents: AgentRegistration[];
  /** The gateway/Restate admin response body (best-effort JSON). */
  response: unknown;
}

/**
 * Register the deployment through the gateway `/registry/deployments`. ONE
 * attempt (0001:T6.2 owns retry/backoff — see module header). Throws on non-2xx.
 */
export async function registerDeployment(
  opts: RegisterDeploymentOptions,
): Promise<RegisterDeploymentResult> {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const url = `${opts.gatewayUrl.replace(/\/$/, "")}/registry/deployments`;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.apiKey !== undefined && { authorization: `Bearer ${opts.apiKey}` }),
      ...opts.headers,
    },
    body: JSON.stringify({ uri: opts.deploymentUrl, force: opts.force ?? true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`registerDeployment: gateway ${res.status} for ${url} — ${text}`);
  }
  const response = await res.json().catch(() => ({}));
  return {
    deploymentUrl: opts.deploymentUrl,
    agents: opts.agents.map((a) => a.registration()),
    response,
  };
}

// ===========================================================================
// serve(...)
// ===========================================================================

export interface ServeOptions {
  /** The agent definitions to deploy. */
  agents: readonly AgentDefinition[];
  /** Deployment seams (outbox, notifier, …) — see `CompileDeps`. */
  deps: CompileDeps;
  /** Listen port (Restate serves the deployment over HTTP/2). Default from env / 9080. */
  port?: number;
  /** Bind the cron object (default true). */
  withCron?: boolean;
  /** Bind the steerbox object (default true). */
  withSteer?: boolean;
  /** When set, register the deployment through the gateway after listening. */
  registration?: Omit<RegisterDeploymentOptions, "agents">;
}

export interface ServeHandle {
  /** The port the endpoint is listening on. */
  port: number;
  /** The compiled Restate objects (one per agent type). */
  objects: AgentObject[];
  /** The registration result, when `registration` was provided. */
  registered?: RegisterDeploymentResult;
}

const DEFAULT_PORT = 9080;

/**
 * Compile the agents, bind + serve the coordination endpoint, and (optionally)
 * register through the gateway. Returns once listening + registered.
 */
export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const objects = opts.agents.map((a) => a.compile(opts.deps));
  const endpoint = createCoordinationEndpoint({
    agents: objects,
    ...(opts.withCron !== undefined && { withCron: opts.withCron }),
    ...(opts.withSteer !== undefined && { withSteer: opts.withSteer }),
  });

  const port =
    opts.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT);
  // restate `endpoint.listen(port)` resolves with the bound port.
  const bound = await endpoint.listen(port);

  const handle: ServeHandle = { port: bound ?? port, objects };
  if (opts.registration) {
    handle.registered = await registerDeployment({ ...opts.registration, agents: opts.agents });
  }
  return handle;
}
