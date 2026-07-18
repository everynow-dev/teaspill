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
    compose: overrides.compose ?? {
      up: composeUp,
      logsFollow: composeLogsFollow,
    },
    watchForRebuild: overrides.watchForRebuild ?? watchForRebuild,
  };
}
