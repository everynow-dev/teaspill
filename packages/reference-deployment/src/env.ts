/**
 * Environment wiring for the reference services (0002:T4.1). One table, both
 * services — see the README for the full reference. Defaults are the
 * compose-overlay in-network values; a host-run service overrides the URLs to
 * the host-published ports (and its OWN deployment URL to
 * `http://host.docker.internal:<port>`, docs/self-hosting-networking.md §3).
 */

export interface CommonServiceEnv {
  port: number;
  gatewayUrl: string;
  ingressUrl: string;
  streamsUrl: string;
  deploymentUrl: string;
  apiKey?: string;
  tenant: string;
}

const str = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const v = env[name];
  return v !== undefined && v !== "" ? v : fallback;
};
const opt = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const v = env[name];
  return v !== undefined && v !== "" ? v : undefined;
};
const flag = (env: NodeJS.ProcessEnv, name: string): boolean =>
  ["1", "true", "yes", "on"].includes((env[name] ?? "").trim().toLowerCase());

export function readCommonEnv(
  env: NodeJS.ProcessEnv,
  defaults: { port: number; deploymentUrl: string },
): CommonServiceEnv {
  const port = Number(str(env, "PORT", String(defaults.port)));
  return {
    port,
    gatewayUrl: str(env, "TEASPILL_GATEWAY_URL", "http://gateway:8787"),
    ingressUrl: str(env, "TEASPILL_INGRESS_URL", "http://restate:8080"),
    streamsUrl: str(env, "TEASPILL_STREAMS_URL", "http://durable-streams:4437"),
    deploymentUrl: str(env, "TEASPILL_DEPLOYMENT_URL", defaults.deploymentUrl),
    ...(opt(env, "TEASPILL_API_KEY") !== undefined && { apiKey: opt(env, "TEASPILL_API_KEY")! }),
    tenant: str(env, "TEASPILL_TENANT", "default"),
  };
}

export interface AgentLoopEnv extends CommonServiceEnv {
  databaseUrl?: string;
  migrate: boolean;
  migrationsDir?: string;
  reconcilerEnabled: boolean;
  workspaceAdapter: string;
  anthropicApiKey?: string;
  demoCasdkEnabled: boolean;
  demoModel?: string;
  casdkSessionDir?: string;
  /**
   * Idle auto-archive delay override, ms (`TEASPILL_IDLE_ARCHIVE_MS`, 0002:T4.2).
   * Unset ⇒ platform default (30 min, 0001:A10); `0` disables. Short values
   * (e.g. `8000`) exist for live-validating the idle-archive → resurrection
   * round-trip — do not run production with a short window.
   */
  idleArchiveDelayMs?: number;
}

export function readAgentLoopEnv(env: NodeJS.ProcessEnv = process.env): AgentLoopEnv {
  const common = readCommonEnv(env, { port: 9080, deploymentUrl: "http://agent-loop:9080" });
  return {
    ...common,
    ...(opt(env, "DATABASE_URL") !== undefined && { databaseUrl: opt(env, "DATABASE_URL")! }),
    migrate: str(env, "TEASPILL_MIGRATE", "1") !== "0",
    ...(opt(env, "TEASPILL_MIGRATIONS_DIR") !== undefined && {
      migrationsDir: opt(env, "TEASPILL_MIGRATIONS_DIR")!,
    }),
    reconcilerEnabled: str(env, "TEASPILL_RECONCILER", "on") !== "off",
    workspaceAdapter: str(env, "TEASPILL_WORKSPACE_ADAPTER", "docker"),
    ...(opt(env, "ANTHROPIC_API_KEY") !== undefined && {
      anthropicApiKey: opt(env, "ANTHROPIC_API_KEY")!,
    }),
    demoCasdkEnabled: flag(env, "TEASPILL_DEMO_CASDK"),
    ...(opt(env, "TEASPILL_DEMO_MODEL") !== undefined && { demoModel: opt(env, "TEASPILL_DEMO_MODEL")! }),
    ...(opt(env, "TEASPILL_CASDK_SESSION_DIR") !== undefined && {
      casdkSessionDir: opt(env, "TEASPILL_CASDK_SESSION_DIR")!,
    }),
    ...(opt(env, "TEASPILL_IDLE_ARCHIVE_MS") !== undefined && {
      idleArchiveDelayMs: Number(opt(env, "TEASPILL_IDLE_ARCHIVE_MS")!),
    }),
  };
}

export interface ExecutorEnv extends CommonServiceEnv {
  /** `docker` (default) or `local-unrestricted` (opt-in host exec — dev only). */
  adapter: string;
}

export function readExecutorEnv(env: NodeJS.ProcessEnv = process.env): ExecutorEnv {
  const common = readCommonEnv(env, { port: 9081, deploymentUrl: "http://executor:9081" });
  return {
    ...common,
    adapter: str(env, "TEASPILL_EXECUTOR_ADAPTER", "docker"),
  };
}
