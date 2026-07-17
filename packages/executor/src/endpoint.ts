/**
 * Restate endpoint wiring for the executor package (T4.1) — mirrors
 * `packages/coordination/src/endpoint.ts`: one endpoint serving the
 * `workspace` virtual object and (optionally, when co-located) the
 * `executor-host` service.
 *
 * Deployment shapes (both supported; networking stance in README §networking):
 * - CO-LOCATED (default dev shape): one process binds both services; the
 *   workspace object may then use `createDirectHostClient` (in-process) or
 *   still call through Restate (`createRestateHostClient`).
 * - SPLIT PLANES: workspace objects on one deployment, `executor-host` on
 *   another (scaled to where the real environments live); the workspace
 *   object MUST use `createRestateHostClient` then.
 */

import * as restate from "@restatedev/restate-sdk";
import type { ExecutorHostService } from "./host.js";
import type { WorkspaceObject } from "./workspace.js";

export interface ExecutorEndpointOptions {
  workspace: WorkspaceObject;
  /** Bind the host service on the same endpoint (co-located shape). */
  host?: ExecutorHostService;
}

/** Build the package's Restate endpoint. Caller serves/listens it and registers the deployment (T1.2 `/registry/*`). */
export function createExecutorEndpoint(opts: ExecutorEndpointOptions) {
  let endpoint = restate.endpoint().bind(opts.workspace);
  if (opts.host) endpoint = endpoint.bind(opts.host);
  return endpoint;
}
