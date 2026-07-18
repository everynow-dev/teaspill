/**
 * Byte-exact reverse proxy helper (0001:R5's load-bearing piece).
 *
 * Design rules, all in service of "resumability must survive the proxy":
 *
 * - The upstream path+query is taken from the RAW request URL and forwarded
 *   verbatim — no re-parsing, no re-encoding, no query reordering. Offset
 *   params (`offset=<16>_<16>`), `live=long-poll|sse`, and `cursor` reach
 *   the durable-streams server byte-identical.
 * - Response headers pass through untouched except hop-by-hop headers
 *   (RFC 9110 §7.6.1). `ETag`, `Cache-Control`, `Stream-Next-Offset`,
 *   `Stream-Up-To-Date`, `Stream-Cursor`, `Stream-Closed`, producer-*
 *   headers etc. all survive verbatim.
 * - Response bodies are STREAMED (never buffered): a parked long-poll's
 *   response begins the instant the upstream produces it, and SSE flows.
 * - Request bodies are buffered (capped upstream of this helper at the 1 MiB
 *   gateway body limit — events/commands are small by design, DECISIONS 0001:A4)
 *   so Content-Length is always exact.
 * - No compression, no transformation: byte offsets computed by the client
 *   against the body remain valid.
 * - Client disconnect mid-request aborts the upstream request (a parked
 *   long-poll doesn't leak a held upstream slot); upstream errors map to 502.
 * - `Authorization` is stripped before forwarding: the API key is a gateway
 *   secret, internal services must never see it.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { Agent, request as undiciRequest, type Dispatcher } from "undici";

/** Hop-by-hop headers (lowercase) never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers additionally stripped before forwarding upstream. */
const REQUEST_STRIP = new Set([
  ...HOP_BY_HOP,
  "host", // upstream sets its own
  "authorization", // gateway API key must not leak to internal services
  "content-length", // recomputed from the buffered body
  "expect",
]);

export function createUpstreamAgent(opts: { headersTimeoutMs: number }): Agent {
  return new Agent({
    // Must exceed durable-streams' long-poll park (30 s default) — see 0001:R5.
    headersTimeout: opts.headersTimeoutMs,
    // SSE bodies are unbounded-duration; never time a body out.
    bodyTimeout: 0,
    keepAliveTimeout: 30_000,
  });
}

function filterRequestHeaders(request: FastifyRequest): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (v === undefined) continue;
    if (REQUEST_STRIP.has(k)) continue;
    out[k] = v;
  }
  const remote = request.socket.remoteAddress;
  if (remote) {
    const prior = request.headers["x-forwarded-for"];
    out["x-forwarded-for"] = prior ? `${String(prior)}, ${remote}` : remote;
  }
  return out;
}

export interface ProxyOptions {
  agent: Dispatcher;
  /** Upstream origin, no trailing slash, e.g. `http://durable-streams:4437`. */
  upstreamBase: string;
  /** Raw path+query to append to the base — forwarded verbatim. */
  upstreamPathAndQuery: string;
  request: FastifyRequest;
  reply: FastifyReply;
  /** Buffered request body (undefined for bodyless methods). */
  body?: Buffer | undefined;
}

export async function proxyRequest(opts: ProxyOptions): Promise<FastifyReply> {
  const { request, reply } = opts;

  // Abort upstream if the client goes away (kills a parked long-poll slot).
  // NOTE: the disconnect signal must come from the RESPONSE ('close' with
  // nothing written), not from `request.raw` — an IncomingMessage emits
  // 'close' as soon as its body has been fully consumed, which for every
  // PUT/POST would abort our own upstream call immediately.
  const ac = new AbortController();
  const rawRes = reply.raw;
  const onClose = (): void => {
    if (!rawRes.writableEnded) ac.abort();
  };
  rawRes.on("close", onClose);

  let res: Dispatcher.ResponseData;
  try {
    res = await undiciRequest(`${opts.upstreamBase}${opts.upstreamPathAndQuery}`, {
      dispatcher: opts.agent,
      method: request.method as Dispatcher.HttpMethod,
      headers: filterRequestHeaders(request),
      body: opts.body ?? null,
      signal: ac.signal,
    });
  } catch (err) {
    rawRes.off("close", onClose);
    if (ac.signal.aborted) {
      // Client disconnected first; nothing to answer.
      return reply.hijack();
    }
    request.log.warn({ err, upstream: opts.upstreamBase }, "upstream request failed");
    return reply.code(502).send({
      error: `upstream unreachable: ${opts.upstreamBase}`,
    });
  }

  reply.code(res.statusCode);
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k)) continue;
    reply.header(k, v as string | string[]);
  }

  if (res.statusCode === 204 || res.statusCode === 304 || request.method === "HEAD") {
    rawRes.off("close", onClose);
    await res.body.dump();
    return reply.send();
  }

  res.body.on("error", () => {
    // Propagated to the client by destroying the connection; nothing else to do.
  });
  res.body.on("close", () => {
    rawRes.off("close", onClose);
  });
  // Streamed, not buffered: long-poll/SSE responses flow through untouched.
  return reply.send(res.body);
}
