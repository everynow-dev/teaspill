/**
 * Shared Restate endpoint wiring for the coordination package (T2.1,
 * minimal + additive): one endpoint serving the cron object (T2.4) plus any
 * number of agent objects built from the T2.1 template.
 *
 * The agent-loop service (D4) calls this at boot with the agent objects the
 * deployment's `defineAgent` definitions compiled (T6.1), then serves it
 * (`endpoint.listen()` / `serve(...)`) and registers the deployment through
 * the gateway (T1.2 `/registry/*`).
 */

import * as restate from "@restatedev/restate-sdk";
import { cronObject } from "./cron.js";
import type { AgentObject } from "./agent.js";

export interface CoordinationEndpointOptions {
  /** Agent virtual objects (one per agent type) to serve alongside cron. */
  agents?: readonly AgentObject[];
  /** Set false to omit the cron object (it is bound by default). */
  withCron?: boolean;
}

/** Build the package's Restate endpoint. Caller serves/listens it. */
export function createCoordinationEndpoint(opts: CoordinationEndpointOptions = {}) {
  let endpoint = restate.endpoint();
  if (opts.withCron !== false) endpoint = endpoint.bind(cronObject);
  for (const agent of opts.agents ?? []) {
    endpoint = endpoint.bind(agent);
  }
  return endpoint;
}
