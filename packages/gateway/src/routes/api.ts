/**
 * `/api/*` — command endpoints translating to Restate ingress sends (0001:T1.2,
 * 0001:D2/0001:D6). All commands are one-way durable sends; the response is 202 with
 * Restate's invocation id, plus derived addressing so callers immediately
 * know the entity url and its timeline stream.
 *
 * Handler-name seam (coordinate with 0001:T2.1, built in the same group): the
 * agent virtual object is assumed to expose `spawn`, `message`, and
 * `control` handlers (PLAN 0001:T2.1's handler list with `signal` renamed to
 * `control` per DECISIONS 0001:A5 / 0001:D8's dropped-POSIX vocabulary). If 0001:T2.1
 * lands different names, this map is the single place to update.
 */

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import {
  AddressingError,
  assertInstanceId,
  entityUrl,
  gatewayStreamUrl,
  newInstanceId,
  restateAgentKey,
  timelineStreamPath,
  TYPE_RE,
} from "../addressing.js";
import { IngressKeyError, type IngressClient } from "../ingress.js";
import { injectTraceContext } from "../otel.js";

export interface ApiRoutesOptions {
  ingress: IngressClient;
  tenant: string;
}

const AGENT_HANDLERS = {
  spawn: "spawn",
  message: "message",
  // Control verbs map to the PER-VERB agent-object handlers (0001:A8: the
  // verbs have different handler kinds — `interrupt` is SHARED so it reaches
  // a busy wake; pause/resume/archive are EXCLUSIVE — so a single `control`
  // dispatcher handler cannot exist). This map is the authoritative
  // public→internal spelling (0002:A1). The previous `control: "control"`
  // entry named a handler the agent object never had — every gateway control
  // verb 404'd at Restate ingress, discovered on the FIRST live interrupt
  // (0002:T4.2; the route's unit tests ran against a fake ingress that
  // accepts any handler name).
  interrupt: "interrupt",
  pause: "pause",
  resume: "resume",
  archive: "archive",
} as const;

const CONTROL_VERBS = new Set(["interrupt", "pause", "resume", "archive"] as const);
type ControlVerb = "interrupt" | "pause" | "resume" | "archive";

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: message });
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const v = request.headers["idempotency-key"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function forward(
  request: FastifyRequest,
  reply: FastifyReply,
  ingress: IngressClient,
  url: string,
  handler: string,
  payload: unknown,
): Promise<FastifyReply> {
  // 0001:T8.2: thread W3C trace context onto the message envelope so the agent
  // handler's `agent.wake` span parents under this request span (the Restate
  // one-way send drops HTTP headers, so the envelope is the carrier). Only a
  // plain-object payload can carry it; primitives/arrays pass through
  // un-instrumented (best-effort, documented in otel.ts).
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    injectTraceContext(payload as Record<string, unknown>, request.otelSpan);
  }

  let result;
  try {
    result = await ingress.send(restateAgentKey(url), handler, payload, {
      idempotencyKey: idempotencyKey(request),
    });
  } catch (err) {
    if (err instanceof IngressKeyError || err instanceof AddressingError) {
      return badRequest(reply, err.message);
    }
    request.log.warn({ err }, "restate ingress send failed");
    return reply.code(502).send({ error: "restate ingress unreachable" });
  }
  if (result.status >= 400) {
    // Surface Restate's own rejection (e.g. unknown service before the
    // deployment registered) without inventing a translation layer.
    return reply.code(result.status === 404 ? 404 : 502).send({
      error: "restate ingress rejected the command",
      restateStatus: result.status,
      restateBody: result.body,
    });
  }
  return reply.code(202).send({
    url,
    streamPath: timelineStreamPath(url),
    streamUrl: gatewayStreamUrl(timelineStreamPath(url)),
    restate: result.body,
  });
}

export const apiRoutes: FastifyPluginCallback<ApiRoutesOptions> = (app, opts, done) => {
  const { ingress, tenant } = opts;

  /**
   * Resolve `{ type, id? , tenant? }` path params to a canonical entity url.
   * Single-tenant deployment (0001:D8): a canonical-form tenant that differs from
   * the deployment tenant is rejected loudly rather than silently accepted.
   */
  function resolveUrl(params: { tenant?: string; type: string; id: string }): string {
    if (params.tenant !== undefined && params.tenant !== tenant) {
      throw new AddressingError(
        `unknown tenant ${JSON.stringify(params.tenant)} (this deployment's tenant is ${JSON.stringify(tenant)})`,
      );
    }
    return entityUrl(tenant, params.type, params.id);
  }

  // ---- spawn ------------------------------------------------------------
  interface SpawnBody {
    type?: unknown;
    id?: unknown;
    args?: unknown;
    parent?: unknown;
    /** Spawn-chosen workspace key `<tenant>/<name>` (0001:D4; additive 0002:T4.2). */
    workspaceRef?: unknown;
  }
  app.post("/api/spawn", async (request, reply) => {
    const body = (request.body ?? {}) as SpawnBody;
    if (typeof body.type !== "string" || !TYPE_RE.test(body.type)) {
      return badRequest(reply, `invalid or missing "type" (must match ${TYPE_RE})`);
    }
    let id: string;
    if (body.id === undefined) {
      id = newInstanceId();
    } else if (typeof body.id === "string") {
      try {
        assertInstanceId(body.id); // rejects "" among everything else (0001:A3)
      } catch (err) {
        return badRequest(reply, (err as Error).message);
      }
      id = body.id;
    } else {
      return badRequest(reply, `"id" must be a string when provided`);
    }
    if (body.parent !== undefined && typeof body.parent !== "string") {
      return badRequest(reply, `"parent" must be an entity url string when provided`);
    }
    if (body.workspaceRef !== undefined && typeof body.workspaceRef !== "string") {
      return badRequest(reply, `"workspaceRef" must be a workspace key string when provided`);
    }
    const url = entityUrl(tenant, body.type, id);
    // `args`/`workspaceRef` are forwarded ONLY when provided: `args: null`
    // used to satisfy handleSpawn's `!== undefined` check and render a junk
    // `"null"` user message on every argless spawn (0002:T4.2 live finding).
    return forward(request, reply, ingress, url, AGENT_HANDLERS.spawn, {
      ...(body.args !== undefined && { args: body.args }),
      parentRef: body.parent ?? null,
      ...(body.workspaceRef !== undefined && { workspaceRef: body.workspaceRef }),
    });
  });

  // ---- send (message wake) ----------------------------------------------
  const sendHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const params = request.params as { tenant?: string; type: string; id: string };
    let url: string;
    try {
      url = resolveUrl(params);
    } catch (err) {
      return badRequest(reply, (err as Error).message);
    }
    if (request.body === undefined || request.body === null) {
      return badRequest(reply, "message body required");
    }
    return forward(request, reply, ingress, url, AGENT_HANDLERS.message, request.body);
  };
  app.post("/api/a/:type/:id/send", sendHandler);
  app.post("/api/t/:tenant/a/:type/:id/send", sendHandler);

  // ---- control (interrupt / pause / resume / archive, 0001:T2.5 verbs) --------
  const controlHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const params = request.params as { tenant?: string; type: string; id: string };
    let url: string;
    try {
      url = resolveUrl(params);
    } catch (err) {
      return badRequest(reply, (err as Error).message);
    }
    const body = (request.body ?? {}) as { verb?: unknown; reason?: unknown };
    if (typeof body.verb !== "string" || !CONTROL_VERBS.has(body.verb as ControlVerb)) {
      return badRequest(
        reply,
        `invalid "verb" (expected one of: ${[...CONTROL_VERBS].join(", ")})`,
      );
    }
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return badRequest(reply, `"reason" must be a string when provided`);
    }
    // Dispatch to the verb's OWN handler (see AGENT_HANDLERS note). The
    // handlers take `ControlInput { reason?: string }` — no verb field.
    return forward(request, reply, ingress, url, AGENT_HANDLERS[body.verb as ControlVerb], {
      ...(body.reason !== undefined && { reason: body.reason }),
    });
  };
  app.post("/api/a/:type/:id/control", controlHandler);
  app.post("/api/t/:tenant/a/:type/:id/control", controlHandler);

  done();
};
