/**
 * The three reverse-proxy route families (0001:T1.2):
 *
 *   /streams/*  → durable-streams server  (0001:R5: long-poll/ETag/offset pass-through)
 *   /shapes/*   → Electric shape API      (headers/params preserved)
 *   /registry/* → Restate admin API       (deployment registration)
 *
 * All use the byte-exact proxy helper (src/proxy.ts). Request bodies are
 * buffered with the gateway-wide cap (1 MiB default — PLAN T1.2c) via a
 * scoped catch-all content-type parser, so Fastify's own body-limit
 * machinery produces the 413.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Dispatcher } from "undici";
import { proxyRequest } from "../proxy.js";

export interface ProxyRoutesOptions {
  agent: Dispatcher;
  durableStreamsUrl: string;
  electricUrl: string;
  restateAdminUrl: string;
  maxBodyBytes: number;
}

/**
 * Raw path+query after `prefix`, taken from the RAW request url (never the
 * router's decoded params) so percent-encoding, query order, and offset
 * params reach the upstream byte-identical.
 */
function rawSuffix(request: FastifyRequest, prefix: string): string | null {
  const raw = request.raw.url ?? "";
  if (!raw.startsWith(prefix)) return null;
  const suffix = raw.slice(prefix.length);
  if (!suffix.startsWith("/")) return null;
  return suffix;
}

function installRawBodyParser(app: FastifyInstance, maxBodyBytes: number): void {
  // Encapsulated per-plugin: proxied bodies are opaque bytes, never parsed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: maxBodyBytes },
    (_req, body, done) => done(null, body),
  );
}

function proxyBody(request: FastifyRequest): Buffer | undefined {
  return Buffer.isBuffer(request.body) ? request.body : undefined;
}

// ---------------------------------------------------------------------------
// /streams/* — durable-streams proxy (0001:R5, the load-bearing route)
// ---------------------------------------------------------------------------

export const streamsRoutes: FastifyPluginCallback<ProxyRoutesOptions> = (app, opts, done) => {
  installRawBodyParser(app, opts.maxBodyBytes);
  app.route({
    // Full stream lifecycle passes through: PUT create (C3: streams must be
    // created before append), POST append (idempotent producer headers pass
    // through untouched), GET catch-up/long-poll/SSE, HEAD, DELETE.
    method: ["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS"],
    url: "/streams/*",
    handler: async (request, reply) => {
      const suffix = rawSuffix(request, "/streams");
      if (suffix === null || suffix === "/") {
        return reply.code(404).send({ error: "missing stream path" });
      }
      return proxyRequest({
        agent: opts.agent,
        upstreamBase: opts.durableStreamsUrl,
        upstreamPathAndQuery: suffix,
        request,
        reply,
        body: proxyBody(request),
      });
    },
  });
  done();
};

// ---------------------------------------------------------------------------
// /shapes/* — Electric proxy
// ---------------------------------------------------------------------------

export const shapesRoutes: FastifyPluginCallback<ProxyRoutesOptions> = (app, opts, done) => {
  installRawBodyParser(app, opts.maxBodyBytes);
  app.route({
    // Shape reads only (GET/HEAD/OPTIONS). `/shapes/v1/shape?...` maps to
    // Electric's `/v1/shape?...`; Electric's `electric-*`/`etag`/
    // `cache-control` headers and long-poll (`live=true`) semantics pass
    // through untouched — same class of requirement as 0001:R5.
    method: ["GET", "HEAD", "OPTIONS"],
    url: "/shapes/*",
    handler: async (request, reply) => {
      const suffix = rawSuffix(request, "/shapes");
      if (suffix === null || suffix === "/") {
        return reply.code(404).send({ error: "missing shape path" });
      }
      return proxyRequest({
        agent: opts.agent,
        upstreamBase: opts.electricUrl,
        upstreamPathAndQuery: suffix,
        request,
        reply,
        body: undefined,
      });
    },
  });
  done();
};

// ---------------------------------------------------------------------------
// /registry/* — Restate admin API forward (deployment registration)
// ---------------------------------------------------------------------------

/**
 * NETWORKING ASSUMPTION (docs/self-hosting-networking.md §3 — inherit, do
 * not rediscover): the deployment `uri` in a registration body is forwarded
 * to Restate's admin API AS-IS, and Restate then dials that URL DIRECTLY on
 * every invocation — that traffic never passes back through this gateway.
 * So the URL must be reachable from inside the `restate` container:
 *
 *   - service on the compose network → register `http://<service-name>:<port>`
 *   - service on the host (local dev) → register
 *     `http://host.docker.internal:<port>`, NEVER `http://localhost:<port>`
 *     (localhost inside the restate container is the container itself;
 *     registration would succeed and the first invocation would fail —
 *     the exact loopback failure mode the doc exists to prevent).
 *
 * The gateway deliberately does NOT rewrite URLs (electric agents'
 * undocumented loopback rewrite is the anti-pattern, PLAN §1); 0001:T6.2's CLI
 * owns defaulting outgoing registration URLs to host.docker.internal.
 */
export const registryRoutes: FastifyPluginCallback<ProxyRoutesOptions> = (app, opts, done) => {
  installRawBodyParser(app, opts.maxBodyBytes);

  const forward = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const suffix = rawSuffix(request, "/registry");
    if (suffix === null || suffix === "/") {
      return reply.code(404).send({ error: "missing registry path" });
    }
    return proxyRequest({
      agent: opts.agent,
      upstreamBase: opts.restateAdminUrl,
      upstreamPathAndQuery: suffix,
      request,
      reply,
      body: proxyBody(request),
    });
  };

  // Allowlist, not a blanket admin proxy: deployment lifecycle (register /
  // list / inspect / update / delete), read-only service+handler discovery,
  // and admin health. Everything else on the admin API (cluster config,
  // invocation kill, etc.) stays unreachable from outside per 0001:D6.
  app.route({
    method: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    url: "/registry/deployments",
    handler: forward,
  });
  app.route({
    method: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    url: "/registry/deployments/*",
    handler: forward,
  });
  app.route({ method: ["GET"], url: "/registry/services", handler: forward });
  app.route({ method: ["GET"], url: "/registry/services/*", handler: forward });
  app.route({ method: ["GET"], url: "/registry/health", handler: forward });

  done();
};
