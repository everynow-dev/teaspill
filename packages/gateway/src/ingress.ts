/**
 * Minimal Restate ingress client for command endpoints (D2 verbs).
 *
 * Ingress URL shape (SPIKE-RESTATE.md (f)/A4-5, Restate 1.7):
 *   POST {ingress}/{service}/{key}/{handler}        — request/response call
 *   POST {ingress}/{service}/{key}/{handler}/send   — one-way durable send
 *
 * DECISIONS A3/A4 obligations implemented here:
 * - keys MUST be percent-encoded in the ingress path (a raw `/` is a 400);
 * - the gateway MUST reject empty keys (an empty object key is legal at
 *   ingress and would silently address a junk object).
 *
 * Spawn/message/control are all one-way durable sends (D2: spawn = one-way
 * send; a wake is an invocation, not an RPC the client blocks on). Client
 * retries are shielded by Restate idempotency keys — the gateway forwards a
 * caller-supplied `Idempotency-Key` header verbatim (SPIKE (c): dedup is
 * guaranteed within retention, default 24 h).
 */

import { request as undiciRequest, type Dispatcher } from "undici";
import type { RestateTarget } from "./addressing.js";

export class IngressKeyError extends Error {}

/** Build an ingress invocation URL. Throws IngressKeyError on an empty key (A3). */
export function ingressUrl(
  base: string,
  target: RestateTarget,
  handler: string,
  mode: "call" | "send",
): string {
  if (target.key.length === 0) {
    throw new IngressKeyError(
      `empty Restate object key for service ${JSON.stringify(target.service)} (DECISIONS A3: the gateway rejects empty keys)`,
    );
  }
  const suffix = mode === "send" ? "/send" : "";
  return `${base}/${target.service}/${encodeURIComponent(target.key)}/${handler}${suffix}`;
}

export interface IngressSendResult {
  status: number;
  /** Restate's response body (e.g. `{ invocationId, status }`) or raw text. */
  body: unknown;
}

export interface IngressClient {
  /** One-way durable send. Resolves with Restate's ingress response. */
  send(
    target: RestateTarget,
    handler: string,
    payload: unknown,
    opts?: { idempotencyKey?: string | undefined },
  ): Promise<IngressSendResult>;
}

export function createIngressClient(opts: {
  agent: Dispatcher;
  ingressBaseUrl: string;
}): IngressClient {
  return {
    async send(target, handler, payload, sendOpts) {
      const url = ingressUrl(opts.ingressBaseUrl, target, handler, "send");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (sendOpts?.idempotencyKey) {
        headers["idempotency-key"] = sendOpts.idempotencyKey;
      }
      const res = await undiciRequest(url, {
        dispatcher: opts.agent,
        method: "POST",
        headers,
        body: JSON.stringify(payload ?? null),
      });
      const text = await res.body.text();
      let body: unknown = text;
      try {
        body = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        // keep raw text
      }
      return { status: res.statusCode, body };
    },
  };
}
