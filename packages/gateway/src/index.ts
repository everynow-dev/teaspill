/**
 * @teaspill/gateway — single entrypoint for the teaspill platform (T1.2, D6).
 *
 * Routes: `/api/*` (commands → Restate ingress), `/streams/*`
 * (durable-streams proxy, R5), `/shapes/*` (Electric proxy), `/registry/*`
 * (Restate admin deployment registration), `/health`.
 *
 * `src/server.ts` is the runnable entrypoint; this module exports the
 * building blocks for embedding and tests.
 */

export { buildGateway, type GatewayDeps } from "./app.js";
export { loadConfig, type GatewayConfig } from "./config.js";
export {
  bearerToken,
  createAuthenticator,
  hashApiKey,
  newApiKey,
  postgresApiKeyStore,
  type ApiKeyRecord,
  type ApiKeyStore,
  type Authenticator,
} from "./auth.js";
export { createIngressClient, ingressUrl, IngressKeyError, type IngressClient } from "./ingress.js";
export { createUpstreamAgent, proxyRequest } from "./proxy.js";
export {
  createReadTokenVerifier,
  looksLikeJwt,
  type ReadTokenResult,
  type ReadTokenVerifier,
} from "./jwt.js";
export {
  parseCorsOrigins,
  resolveAllowedOrigin,
  type CorsOriginPolicy,
} from "./cors.js";
export { initTelemetry, getTracer } from "./otel.js";
