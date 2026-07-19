/**
 * Config resolution for the `teaspill` CLI (0001:T6.2).
 *
 * The CLI is a client of the gateway (0001:D6 single entrypoint): it needs a
 * gateway base URL and — for every route except `GET /health` — an API key.
 * Both resolve from flags first, then environment, then a sane default.
 *
 * Env names are deliberately CLIENT-side and distinct from the gateway's own
 * server-side vars (which name the *upstream* services). They align with the
 * gateway/compose defaults:
 *
 *   TEASPILL_GATEWAY_URL   default http://localhost:8787   (compose GATEWAY_PORT=8787)
 *   TEASPILL_API_KEY       —                               (gateway `Authorization: Bearer`)
 *   TEASPILL_TENANT        default default                 (gateway TEASPILL_TENANT)
 *   TEASPILL_DEPLOYMENT_URL default http://host.docker.internal:9080
 *                                    (agents-sdk serve() DEFAULT_PORT; the
 *                                     host.docker.internal registration stance,
 *                                     work/plans/0001-build-v1/notes/self-hosting-networking.md §3)
 *
 * Flags (`--gateway`, `--api-key`, `--tenant`, `--deployment`) override env.
 */

export const DEFAULT_GATEWAY_URL = "http://localhost:8787";
export const DEFAULT_TENANT = "default";
/** agents-sdk `serve()` DEFAULT_PORT, reached from the restate container via host.docker.internal. */
export const DEFAULT_DEPLOYMENT_URL = "http://host.docker.internal:9080";

export interface CliGlobalFlags {
  gateway?: string;
  apiKey?: string;
  tenant?: string;
}

export interface ResolvedConfig {
  gatewayUrl: string;
  /** Undefined when neither flag nor env supplied one (fine for `GET /health`). */
  apiKey: string | undefined;
  tenant: string;
}

export type EnvLike = Record<string, string | undefined>;

/** Resolve gateway URL + API key + tenant from flags, then env, then defaults. */
export function resolveConfig(
  flags: CliGlobalFlags = {},
  env: EnvLike = process.env,
): ResolvedConfig {
  const gatewayUrl = trimTrailingSlash(
    firstDefined(flags.gateway, env["TEASPILL_GATEWAY_URL"]) ?? DEFAULT_GATEWAY_URL,
  );
  const apiKey = firstDefined(flags.apiKey, env["TEASPILL_API_KEY"]);
  const tenant = firstDefined(flags.tenant, env["TEASPILL_TENANT"]) ?? DEFAULT_TENANT;
  return { gatewayUrl, apiKey, tenant };
}

/** Resolve the deployment URL(s) the dev loop registers (flag list → env → default). */
export function resolveDeploymentUrls(
  flagUrls: readonly string[] | undefined,
  env: EnvLike = process.env,
): string[] {
  if (flagUrls !== undefined && flagUrls.length > 0) return [...flagUrls];
  const fromEnv = env["TEASPILL_DEPLOYMENT_URL"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return [DEFAULT_DEPLOYMENT_URL];
}

/**
 * Warn (never rewrite) when a deployment URL points at loopback: Restate dials
 * registered URIs from *inside* the container, so `localhost`/`127.0.0.1`
 * resolves to the container itself, not the host — every invocation then fails.
 * The gateway deliberately performs no rewrite (README "Registration
 * networking"); the CLI's job is to default correctly and flag the footgun.
 * Returns a warning string, or null when the URL is fine.
 */
export function deploymentUrlWarning(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return `deployment URL is not a valid URL: ${JSON.stringify(url)}`;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
    return (
      `deployment URL ${JSON.stringify(url)} points at loopback — Restate dials it from ` +
      `inside the container, where ${host} is the container itself. Use ` +
      `http://host.docker.internal:<port> for a host-run dev service ` +
      `(work/plans/0001-build-v1/notes/self-hosting-networking.md §3).`
    );
  }
  return null;
}

function firstDefined(...values: (string | undefined)[]): string | undefined {
  for (const v of values) if (v !== undefined && v !== "") return v;
  return undefined;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
