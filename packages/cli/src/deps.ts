/**
 * Dependency-injection surface for the CLI (0001:T6.2).
 *
 * Every command reaches the outside world (gateway HTTP, docker, the clock,
 * process I/O) through a `CliDeps` object. `createDefaultDeps()` wires the real
 * frontend-sdk (actions/catalog/timeline) + agents-sdk (registerDeployment)
 * clients; tests pass fakes so each subcommand's parse/dispatch and the
 * register retry/backoff are exercised WITHOUT a live stack.
 */

import {
  createActionsClient,
  createAgentCatalog,
  createAgentTimeline,
  type ActionsClient,
  type ActionsClientOptions,
  type AgentCatalog,
  type AgentCatalogOptions,
  type AgentTimeline,
  type AgentTimelineOptions,
} from "@teaspill/frontend-sdk";
import {
  registerDeployment,
  type RegisterDeploymentOptions,
  type RegisterDeploymentResult,
} from "@teaspill/agents-sdk";
import {
  createCatalogClient,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyListRow,
  type CreatedApiKey,
  type RevokeResult,
} from "@teaspill/catalog";
import {
  composeUp,
  composeLogsFollow,
  watchForRebuild,
  type ComposeOptions,
  type RunningProcess,
  type WatchHandle,
  type WatchOptions,
} from "./compose.js";
import { defaultSleep } from "./register.js";

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

/**
 * Operator-context API-key admin store for `teaspill keys` (0002:T5.1). Backed
 * by a direct catalog Postgres connection (NOT the gateway); injected so the
 * command runs against a fake with no live DB. `create` mints + stores the
 * sha256 hash and returns the plaintext token once; `close` releases the pool.
 */
export interface KeysStore {
  create(opts: { label?: string }): Promise<CreatedApiKey>;
  revoke(selector: string): Promise<RevokeResult>;
  list(): Promise<ApiKeyListRow[]>;
  close(): Promise<void>;
}

export interface CliDeps {
  io: CliIO;
  /** Terminate the process (default `process.exit`). */
  exit(code: number): void;
  /** Abortable sleep (ms). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** `GET <gatewayUrl>/health` → 2xx. */
  healthProbe(gatewayUrl: string): Promise<boolean>;

  createActionsClient(opts: ActionsClientOptions): ActionsClient;
  createAgentCatalog(opts: AgentCatalogOptions): AgentCatalog;
  createAgentTimeline(streamUrl: string | URL, opts?: AgentTimelineOptions): AgentTimeline;
  registerDeployment(opts: RegisterDeploymentOptions): Promise<RegisterDeploymentResult>;
  /** Operator-context key admin store bound to `databaseUrl` (see KeysStore). */
  createKeysStore(databaseUrl: string): KeysStore;

  compose: {
    up(opts?: ComposeOptions): Promise<number | null>;
    logsFollow(opts?: ComposeOptions): RunningProcess;
  };
  watchForRebuild(paths: readonly string[], onChange: () => void, opts?: WatchOptions): WatchHandle;
}

/** Real deps: stdout/stderr, fetch, docker, and the SDK clients. */
export function createDefaultDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const io: CliIO = overrides.io ?? {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
  return {
    io,
    exit: overrides.exit ?? ((code) => process.exit(code)),
    sleep: overrides.sleep ?? defaultSleep,
    healthProbe:
      overrides.healthProbe ??
      (async (gatewayUrl) => {
        const res = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/health`, { method: "GET" });
        return res.ok;
      }),
    createActionsClient: overrides.createActionsClient ?? createActionsClient,
    createAgentCatalog: overrides.createAgentCatalog ?? createAgentCatalog,
    createAgentTimeline: overrides.createAgentTimeline ?? createAgentTimeline,
    registerDeployment: overrides.registerDeployment ?? registerDeployment,
    createKeysStore:
      overrides.createKeysStore ??
      ((databaseUrl) => {
        const { db, sql } = createCatalogClient({ databaseUrl });
        return {
          create: (opts) => createApiKey(db, opts),
          revoke: (selector) => revokeApiKey(db, selector),
          list: () => listApiKeys(db),
          close: () => sql.end(),
        };
      }),
    compose: overrides.compose ?? {
      up: composeUp,
      logsFollow: composeLogsFollow,
    },
    watchForRebuild: overrides.watchForRebuild ?? watchForRebuild,
  };
}
