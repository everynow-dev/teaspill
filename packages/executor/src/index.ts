/**
 * @teaspill/executor — the executor plane (0001:D4, 0001:T4.1).
 *
 * `workspace/<key>` virtual objects front real environments; an executor
 * host service owns the environments behind the `ExecutorAdapter` seam
 * (0001:T4.2 adds `docker` + `local-unrestricted`). See README.md for the design
 * note and networking stance.
 */

// Addressing / keys
export * from "./keys.js";

// Errors + containment (the one containment module — anticipate-b)
export * from "./errors.js";
export * from "./path-containment.js";

// Adapter seam (0001:T4.2 implements) + the dev-only local adapter
export * from "./adapter.js";
export {
  createLocalAdapter,
  DEFAULT_FS_READ_BUDGET_BYTES,
  type LocalAdapterOptions,
} from "./local-adapter.js";

// 0001:T4.2 adapters: hardened host profile + docker (container per workspace)
export * from "./local-unrestricted-adapter.js";
export * from "./docker-cli.js";
export * from "./docker-adapter.js";
export * from "./adapter-registry.js";
export { TailBuffer } from "./tail-buffer.js";

// Out-of-band stdout sink seam
export * from "./stream-sink.js";

// Executor host (service) + workspace→host client seam
export * from "./host.js";
export * from "./host-client.js";

// Workspace virtual object
export * from "./workspace-runtime.js";
export * from "./workspace.js";

// Exec abort → kill mapping (0002:T3.1): client-side abort-signal → workspace kill
export * from "./exec-abort.js";

// Endpoint wiring
export * from "./endpoint.js";

// Observability (0001:T8.2)
export * from "./otel.js";
