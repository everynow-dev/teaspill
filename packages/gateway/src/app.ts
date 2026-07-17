/**
 * Gateway app assembly (T1.2, D6: the single entrypoint).
 *
 * Framework: Fastify. Rationale (task asked for the choice to be justified):
 * boring, mature, Node-native HTTP with (a) first-class streaming replies —
 * `reply.send(readable)` pipes without buffering, which the R5 long-poll
 * pass-through requires; (b) built-in per-route/parser body limits that give
 * us the 1 MiB cap (T1.2c) without hand-rolling counting streams; (c) pino
 * structured request logging built in; (d) NO default compression/transform
 * middleware that would corrupt byte offsets. Hono's Node adapter is
 * younger and adds a web-standards Request/Response translation layer in
 * exactly the hot path a byte-exact proxy wants to keep native.
 *
 * Middleware order: request-id + pino logging (Fastify core) → OTel span
 * (onRequest) → API-key auth (onRequest, everything except /health) →
 * routes.
 */

import fastify, { type FastifyInstance } from "fastify";
import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { Agent } from "undici";
import type { GatewayConfig } from "./config.js";
import { bearerToken, type Authenticator } from "./auth.js";
import { getTracer } from "./otel.js";
import { createUpstreamAgent } from "./proxy.js";
import { createIngressClient } from "./ingress.js";
import { apiRoutes } from "./routes/api.js";
import {
  registryRoutes,
  shapesRoutes,
  streamsRoutes,
  type ProxyRoutesOptions,
} from "./routes/proxies.js";

export interface GatewayDeps {
  authenticator: Authenticator;
  /** Override the upstream agent (tests inject shorter timeouts). */
  upstreamAgent?: Agent;
}

declare module "fastify" {
  interface FastifyRequest {
    otelSpan?: Span;
  }
}

/** Coarse route bucket for spans/metrics — bounded cardinality, never the raw path. */
function routeBucket(url: string): string {
  if (url === "/health") return "/health";
  for (const p of ["/api", "/streams", "/shapes", "/registry"] as const) {
    if (url === p || url.startsWith(`${p}/`)) return `${p}/*`;
  }
  return "other";
}

export function buildGateway(config: GatewayConfig, deps: GatewayDeps): FastifyInstance {
  const app = fastify({
    logger: { level: config.logLevel },
    // 1 MiB cap on parsed bodies (T1.2c). Proxy plugins re-declare the same
    // cap on their raw-buffer parsers; oversize → 413 via the error handler.
    bodyLimit: config.maxBodyBytes,
    requestIdHeader: "x-request-id",
    // Long-poll responses can legitimately take >30 s to start; never let
    // the server kill an in-flight request under them.
    requestTimeout: 0,
  });

  const agent =
    deps.upstreamAgent ??
    createUpstreamAgent({ headersTimeoutMs: config.upstreamHeadersTimeoutMs });
  app.addHook("onClose", async () => {
    await agent.close();
  });

  // ---- OTel span per request ---------------------------------------------
  const tracer = getTracer();
  app.addHook("onRequest", (request, _reply, done) => {
    request.otelSpan = tracer.startSpan("gateway.request", {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": request.method,
        "url.path.bucket": routeBucket(request.url),
        "http.request.id": request.id,
      },
    });
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    const span = request.otelSpan;
    if (span) {
      span.setAttribute("http.response.status_code", reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    done();
  });

  // ---- API-key auth (D6) ---------------------------------------------------
  app.addHook("onRequest", async (request, reply) => {
    if (request.raw.url === "/health") return;
    const key = bearerToken(request.headers.authorization);
    if (key === null) {
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({ error: "missing API key (Authorization: Bearer <key>)" });
    }
    const ok = await deps.authenticator.verify(key);
    if (!ok) {
      request.log.info("rejected invalid or revoked API key");
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({ error: "invalid or revoked API key" });
    }
  });

  // ---- error shaping --------------------------------------------------------
  app.setErrorHandler((rawErr, request, reply) => {
    const err = rawErr as { code?: string; statusCode?: number; message?: string };
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE" || err.statusCode === 413) {
      return reply.code(413).send({
        error: `request body exceeds the ${config.maxBodyBytes}-byte limit (attachments are out of scope in v1 — bulk data belongs on a durable stream, not in a command payload)`,
      });
    }
    if (err.statusCode !== undefined && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message ?? "bad request" });
    }
    request.log.error({ err }, "unhandled gateway error");
    return reply.code(500).send({ error: "internal gateway error" });
  });

  // ---- routes ----------------------------------------------------------------
  app.get("/health", async () => ({ ok: true }));

  const ingress = createIngressClient({ agent, ingressBaseUrl: config.restateIngressUrl });
  void app.register(apiRoutes, { ingress, tenant: config.tenant });

  const proxyOpts: ProxyRoutesOptions = {
    agent,
    durableStreamsUrl: config.durableStreamsUrl,
    electricUrl: config.electricUrl,
    restateAdminUrl: config.restateAdminUrl,
    maxBodyBytes: config.maxBodyBytes,
  };
  void app.register(streamsRoutes, proxyOpts);
  void app.register(shapesRoutes, proxyOpts);
  void app.register(registryRoutes, proxyOpts);

  return app;
}
