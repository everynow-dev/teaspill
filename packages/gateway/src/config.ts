/**
 * Gateway configuration (0001:T1.2). Everything comes from env with documented
 * defaults — `.env.example` is owned by 0001:T1.1 and is deliberately NOT edited
 * by this package; the full env-var list lives in this package's README.
 *
 * The upstream URL defaults match `docker-compose.yml`'s gateway service
 * env (compose-network service DNS names per docs/self-hosting-networking.md
 * §1); the localhost fallbacks are for running the gateway directly on the
 * host against the compose stack's published ports.
 */

import { parseCorsOrigins, type CorsOriginPolicy } from "./cors.js";

export interface GatewayConfig {
  /** Listen port. Env: PORT. Default 8787 (compose-internal port). */
  port: number;
  /** Listen host. Env: HOST. Default 0.0.0.0. */
  host: string;
  /**
   * Deployment tenant (docs/addressing.md §1; 0001:D8: a tenant is a deployment).
   * Used to expand the `/a/<type>/<id>` short form to the canonical
   * `/t/<tenant>/a/<type>/<id>`. Env: TEASPILL_TENANT. Default "default".
   */
  tenant: string;
  /** Restate ingress base URL. Env: RESTATE_INGRESS_URL. */
  restateIngressUrl: string;
  /** Restate admin API base URL (deployment registration). Env: RESTATE_ADMIN_URL. */
  restateAdminUrl: string;
  /** Electric shape API base URL. Env: ELECTRIC_URL. */
  electricUrl: string;
  /** durable-streams server base URL. Env: DURABLE_STREAMS_URL. */
  durableStreamsUrl: string;
  /**
   * Postgres connection string for `api_keys` lookups (@teaspill/catalog).
   * Env: DATABASE_URL. Optional ONLY when GATEWAY_BOOTSTRAP_API_KEY is set
   * (dev convenience); the server refuses to start with neither.
   */
  databaseUrl: string | undefined;
  /**
   * Dev-bootstrap API key: when set, this literal key is accepted (compared
   * constant-time against its own hash) in addition to Postgres-backed keys,
   * so a fresh stack with an empty `api_keys` table is usable before any key
   * has been minted. Never set this in production.
   * Env: GATEWAY_BOOTSTRAP_API_KEY.
   */
  bootstrapApiKey: string | undefined;
  /**
   * Max request body size in bytes for command endpoints and proxied writes
   * (PLAN T1.2c: attachments are out of scope v1; bulk data belongs on
   * streams — see also DECISIONS 0001:A4's ≤~1 MiB journal-entry budget).
   * Env: GATEWAY_MAX_BODY_BYTES. Default 1 MiB.
   */
  maxBodyBytes: number;
  /**
   * How long we allow an upstream to sit on a request before first response
   * bytes (headers). Must comfortably exceed durable-streams' long-poll
   * timeout (30 s default) or the gateway would sever parked long-polls (0001:R5).
   * Env: GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS. Default 120000.
   */
  upstreamHeadersTimeoutMs: number;
  /**
   * HS256 shared secret for the optional JWT read path (0001:T1.4, 0001:D6). When set,
   * a GET on `/streams/*` or `/shapes/*` may present a short-lived read token
   * (minted by @teaspill/agents-sdk `mintReadToken`) in place of an API key;
   * the gateway verifies HS256 + `exp` and checks the `pfx` claim is a prefix
   * of the requested path. When UNSET the JWT path is disabled and only API
   * keys are accepted. Never honoured for writes (`/api/*`, `/registry/*`) or
   * non-GET requests. Env: GATEWAY_JWT_SECRET.
   */
  jwtSecret: string | undefined;
  /**
   * Clock-skew leeway (seconds) applied when verifying a read token's `exp`,
   * so a token that just crossed the boundary against a slightly-off clock is
   * not spuriously rejected mid-long-poll. Clients reconnect with a fresh
   * token on 401 regardless — this only smooths the boundary. Env:
   * GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS. Default 60.
   */
  jwtClockToleranceSeconds: number;
  /**
   * Allowed CORS origins for the browser-facing read routes (`/streams/*`,
   * `/shapes/*` GET + preflight). `*` (default) allows any origin; a
   * comma-separated list reflects only listed origins. Never applied to
   * `/api/*` or `/registry/*`. Env: GATEWAY_CORS_ALLOW_ORIGINS.
   */
  corsAllowOrigins: CorsOriginPolicy;
  /** pino level. Env: LOG_LEVEL. Default "info". */
  logLevel: string;
  /**
   * OTLP trace exporter endpoint; the tracer is always installed but spans
   * are only exported when this is set (exporter is env-gated).
   * Env: OTEL_EXPORTER_OTLP_ENDPOINT.
   */
  otlpEndpoint: string | undefined;
}

function intEnv(v: string | undefined, fallback: number, what: string): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid ${what}: ${JSON.stringify(v)} (expected a positive integer)`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    port: intEnv(env.PORT, 8787, "PORT"),
    host: env.HOST ?? "0.0.0.0",
    tenant: env.TEASPILL_TENANT ?? "default",
    restateIngressUrl: stripTrailingSlash(env.RESTATE_INGRESS_URL ?? "http://localhost:8080"),
    restateAdminUrl: stripTrailingSlash(env.RESTATE_ADMIN_URL ?? "http://localhost:9070"),
    electricUrl: stripTrailingSlash(env.ELECTRIC_URL ?? "http://localhost:3000"),
    durableStreamsUrl: stripTrailingSlash(env.DURABLE_STREAMS_URL ?? "http://localhost:4437"),
    databaseUrl: env.DATABASE_URL,
    bootstrapApiKey: env.GATEWAY_BOOTSTRAP_API_KEY,
    maxBodyBytes: intEnv(env.GATEWAY_MAX_BODY_BYTES, 1024 * 1024, "GATEWAY_MAX_BODY_BYTES"),
    upstreamHeadersTimeoutMs: intEnv(
      env.GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS,
      120_000,
      "GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS",
    ),
    jwtSecret: env.GATEWAY_JWT_SECRET,
    jwtClockToleranceSeconds: intEnv(
      env.GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS,
      60,
      "GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS",
    ),
    corsAllowOrigins: parseCorsOrigins(env.GATEWAY_CORS_ALLOW_ORIGINS),
    logLevel: env.LOG_LEVEL ?? "info",
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
