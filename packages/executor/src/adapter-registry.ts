/**
 * Adapter registry / selection (T4.2) — a small factory that resolves the
 * bundled adapters by NAME into the `Record<string, ExecutorAdapter>` the
 * executor host consumes (host.ts `adapters` map; `host.adapterFor` looks each
 * workspace's `config.adapter` up in it, D4 — `workspaceRef` fixed at spawn).
 *
 * The host already selects per workspace by `config.adapter`; this factory's
 * only job is BUILDING the map — instantiating exactly the adapters a
 * deployment configures (each carries its own construction options and, for
 * `local-unrestricted`, its own opt-in gate). Keeping selection here (not in
 * the host) preserves the minimal seam so E2B/Firecracker register the same
 * way later.
 */

import type { ExecutorAdapter } from "./adapter.js";
import { createDockerAdapter, type DockerAdapterOptions } from "./docker-adapter.js";
import { createLocalAdapter, type LocalAdapterOptions } from "./local-adapter.js";
import {
  createLocalUnrestrictedAdapter,
  type LocalUnrestrictedAdapterOptions,
} from "./local-unrestricted-adapter.js";

/**
 * Which adapters to build and with what options. Only the keys present are
 * instantiated — a deployment that never configures `local`/`local-unrestricted`
 * cannot accidentally select host execution.
 */
export interface AdapterRegistryConfig {
  local?: LocalAdapterOptions;
  localUnrestricted?: LocalUnrestrictedAdapterOptions;
  docker?: DockerAdapterOptions;
}

/**
 * Build the adapters map for the executor host from config. Keyed by the
 * adapter's own `name` (`local` | `local-unrestricted` | `docker`), matching
 * the `config.adapter` the host resolves against.
 */
export function createAdapterRegistry(config: AdapterRegistryConfig): Record<string, ExecutorAdapter> {
  const registry: Record<string, ExecutorAdapter> = {};
  if (config.local) registry.local = createLocalAdapter(config.local);
  if (config.localUnrestricted) {
    registry["local-unrestricted"] = createLocalUnrestrictedAdapter(config.localUnrestricted);
  }
  if (config.docker) registry.docker = createDockerAdapter(config.docker);
  return registry;
}

/**
 * Single-adapter selector by name (the same names the host resolves). Useful
 * when a caller knows the one adapter it wants rather than building a map.
 */
export function createAdapter(
  name: "local" | "local-unrestricted" | "docker",
  options: LocalAdapterOptions | LocalUnrestrictedAdapterOptions | DockerAdapterOptions,
): ExecutorAdapter {
  switch (name) {
    case "local":
      return createLocalAdapter(options as LocalAdapterOptions);
    case "local-unrestricted":
      return createLocalUnrestrictedAdapter(options as LocalUnrestrictedAdapterOptions);
    case "docker":
      return createDockerAdapter(options as DockerAdapterOptions);
  }
}
