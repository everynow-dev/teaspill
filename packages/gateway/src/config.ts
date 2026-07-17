/**
 * Gateway configuration (T1.2). Everything comes from env with documented
 * defaults — `.env.example` is owned by T1.1 and is deliberately NOT edited
 * by this package; the full env-var list lives in this package's README.
 *
 * The upstream URL defaults match `docker-compose.yml`'s gateway service
 * env (compose-network service DNS names per docs/self-hosting-networking.md
 * §1); the localhost fallbacks are for running the gateway directly on the
 * host against the compose stack's published ports.
 */

export interface GatewayConfig {
  /** Listen port. Env: PORT. Default 8787 (compose-internal port). */
  port: number;
  /** Listen host. Env: HOST. Default 0.0.0.0. */
  host: string;
  /**
   * Deployment tenant (docs/addressing.md §1; D8: a tenant is a deployment).
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
   * streams — see also DECISIONS A4's ≤~1 MiB journal-entry budget).
   * Env: GATEWAY_MAX_BODY_BYTES. Default 1 MiB.
   */
  maxBodyBytes: number;
  /**
   * How long we allow an upstream to sit on a request before first response
   * bytes (headers). Must comfortably exceed durable-streams' long-poll
   * timeout (30 s default) or the gateway would sever parked long-polls (R5).
   * Env: GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS. Default 120000.
   */
  upstreamHeadersTimeoutMs: number;
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
    logLevel: env.LOG_LEVEL ?? "info",
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
