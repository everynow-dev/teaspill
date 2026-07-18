/**
 * Gateway app assembly (0001:T1.2, 0001:D6: the single entrypoint).
 *
 * Framework: Fastify. Rationale (task asked for the choice to be justified):
 * boring, mature, Node-native HTTP with (a) first-class streaming replies —
 * `reply.send(readable)` pipes without buffering, which the 0001:R5 long-poll
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
import { createReadTokenVerifier, looksLikeJwt, type ReadTokenVerifier } from "./jwt.js";
import { resolveAllowedOrigin } from "./cors.js";
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

/** Path portion of a raw url (drops the query) — what a `pfx` claim matches against. */
function pathOf(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

/** The two browser-readable proxy families the JWT/CORS read path applies to. */
function isReadProxyPath(path: string): boolean {
  for (const p of ["/streams", "/shapes"] as const) {
    if (path === p || path.startsWith(`${p}/`)) return true;
  }
  return false;
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

  // ---- auth (0001:D6): API key everywhere; optional JWT read path on GET reads ---
  //
  // Composition & precedence (documented in README "Auth"):
  //   * The two credentials are told apart by SHAPE, so neither verifier ever
  //     runs twice and the API-key path is byte-for-byte unchanged for
  //     server-side callers: a three-segment `a.b.c` bearer token on a GET
  //     `/streams|/shapes` request (with a secret configured) is verified as a
  //     read token; everything else goes through the API-key path.
  //   * The JWT path is GET-only and streams/shapes-only. A JWT-shaped token
  //     on `/api/*`, `/registry/*`, or any non-GET method falls through to the
  //     API-key path, where it fails the digest lookup → 401. Writes never
  //     bypass the developer (0001:D6).
  //   * CORS preflight (OPTIONS) for the read routes is answered locally,
  //     before auth, so a browser's cross-origin read is not blocked.
  const readTokenVerifier: ReadTokenVerifier | null = config.jwtSecret
    ? createReadTokenVerifier({
        secret: config.jwtSecret,
        clockToleranceSeconds: config.jwtClockToleranceSeconds,
      })
    : null;

  app.addHook("onRequest", async (request, reply) => {
    const path = pathOf(request.raw.url ?? "");
    if (path === "/health") return;

    const readProxy = isReadProxyPath(path);

    // CORS preflight for the browser read routes — answered here, never
    // proxied and never authenticated (a preflight carries no credentials).
    if (request.method === "OPTIONS") {
      if (readProxy) {
        const allow = resolveAllowedOrigin(request.headers.origin, config.corsAllowOrigins);
        if (allow !== null) {
          reply.header("access-control-allow-origin", allow);
          if (allow !== "*") reply.header("vary", "Origin");
          reply.header("access-control-allow-methods", "GET, HEAD, OPTIONS");
          reply.header(
            "access-control-allow-headers",
            request.headers["access-control-request-headers"] ??
              "authorization, if-none-match, cache-control, content-type",
          );
          reply.header("access-control-max-age", "600");
        }
        return reply.code(204).send();
      }
      // OPTIONS on a non-read route: no CORS (writes stay server-side, 0001:D6);
      // fall through to the API-key path, which will 401.
    }

    const token = bearerToken(request.headers.authorization);

    // JWT read path: GET on /streams|/shapes with an HS256 read token.
    if (
      readTokenVerifier !== null &&
      request.method === "GET" &&
      readProxy &&
      token !== null &&
      looksLikeJwt(token)
    ) {
      const result = await readTokenVerifier.verify(token);
      if (!result.ok) {
        request.log.info({ reason: result.reason }, "rejected read token");
        return reply
          .code(401)
          .header("www-authenticate", 'Bearer error="invalid_token"')
          .send({
            error:
              result.reason === "expired"
                ? "read token expired — reconnect with a fresh token (the stream is resumable: resume from your last offset)"
                : "invalid read token — reconnect with a fresh token",
          });
      }
      if (!path.startsWith(result.pfx)) {
        request.log.info({ pfx: result.pfx }, "read token pfx does not cover path");
        return reply.code(403).send({
          error: `read token is not authorized for this path (token pfx=${JSON.stringify(result.pfx)})`,
        });
      }
      return; // authorized via read token
    }

    // API-key path (unchanged) — server-side callers and anything that is not
    // a browser read token.
    if (token === null) {
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({ error: "missing API key (Authorization: Bearer <key>)" });
    }
    const ok = await deps.authenticator.verify(token);
    if (!ok) {
      request.log.info("rejected invalid or revoked API key");
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({ error: "invalid or revoked API key" });
    }
  });

  // ---- CORS response headers on the browser read routes --------------------
  // Applied to every GET on /streams|/shapes (200 proxied reads AND 401/403
  // rejections alike) so a cross-origin browser can READ the status/body and
  // react — e.g. reconnect with a fresh token on a 401. removeHeader first so
  // an upstream that already emits CORS (Electric) does not double the header.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method === "GET" && isReadProxyPath(pathOf(request.raw.url ?? ""))) {
      const allow = resolveAllowedOrigin(request.headers.origin, config.corsAllowOrigins);
      if (allow !== null) {
        reply.removeHeader("access-control-allow-origin");
        reply.removeHeader("access-control-expose-headers");
        reply.header("access-control-allow-origin", allow);
        // Non-credentialed reads → `*` may expose all headers, so the
        // durable-streams / Electric offset/cursor/etag headers the client
        // needs are all readable cross-origin.
        reply.header("access-control-expose-headers", "*");
        if (allow !== "*") reply.header("vary", "Origin");
      }
    }
    return payload;
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
