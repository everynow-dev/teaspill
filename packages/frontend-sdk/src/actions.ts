/**
 * Actions client (0001:T5.2): spawn / send / control against the gateway's
 * `/api/*` command routes (0001:T1.2). Writes ALWAYS go through the gateway
 * (0001:D6 — writes never bypass the developer): use an API key (server-side) or
 * whatever credential the developer's proxy accepts; the 0001:T1.4 read token is
 * GET-/streams-/shapes-only and will be rejected here by design.
 *
 * Route shapes (packages/gateway/src/routes/api.ts):
 *   POST /api/spawn                          { type, id?, args?, parent? }
 *   POST /api/a/:type/:id/send               <message JSON>
 *   POST /api/a/:type/:id/control            { verb, reason? }
 * All are one-way durable sends; the gateway answers 202 with the entity url
 * and its timeline stream URL, which feed straight into createAgentTimeline.
 */

import { ENTITY_URL_RE, ID_RE, SHORT_FORM_RE, TYPE_RE } from "@teaspill/schema";
import type { ControlVerb, JsonValue } from "@teaspill/schema";
import { resolveAuthHeader, type TeaspillAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `{ type, id }`, a gateway short form `/a/<type>/<id>`, or a canonical url. */
export type EntityTarget = string | { type: string; id: string };

/** The gateway's 202 response for every command. */
export interface ActionAccepted {
  /** Canonical entity url (`/t/<tenant>/a/<type>/<id>`). */
  url: string;
  /** Timeline stream server path. */
  streamPath: string;
  /** Gateway URL for the timeline stream (feed to createAgentTimeline). */
  streamUrl: string;
  /** Restate ingress response body (invocation id). */
  restate: unknown;
}

export interface ActionsClientOptions {
  /** Gateway origin, e.g. `https://gateway.example.com` (no trailing slash needed). */
  baseUrl: string | URL;
  auth?: TeaspillAuth;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  /** Forwarded as `Idempotency-Key` → Restate ingress dedup (0001:T1.2/0001:A4). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface SpawnRequest {
  type: string;
  /** Caller-supplied id for deterministic/idempotent spawn (addressing §3.2). */
  id?: string;
  args?: JsonValue;
  /** Parent entity url. */
  parent?: string;
}

export class GatewayActionError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `gateway rejected the command (HTTP ${status})`);
    this.name = "GatewayActionError";
  }
}

export interface ActionsClient {
  spawn(request: SpawnRequest, opts?: RequestOptions): Promise<ActionAccepted>;
  /** Message wake (0001:D2). `message` is the developer-defined inbox payload. */
  send(target: EntityTarget, message: JsonValue, opts?: RequestOptions): Promise<ActionAccepted>;
  /** Control verbs (0001:T2.5/0001:D8): interrupt | pause | resume | archive. */
  control(
    target: EntityTarget,
    verb: ControlVerb,
    reason?: string,
    opts?: RequestOptions,
  ): Promise<ActionAccepted>;
  interrupt(target: EntityTarget, reason?: string, opts?: RequestOptions): Promise<ActionAccepted>;
  pause(target: EntityTarget, opts?: RequestOptions): Promise<ActionAccepted>;
  resume(target: EntityTarget, opts?: RequestOptions): Promise<ActionAccepted>;
  archive(target: EntityTarget, opts?: RequestOptions): Promise<ActionAccepted>;
}

// ---------------------------------------------------------------------------
// Target → gateway path
// ---------------------------------------------------------------------------

// Regexes are @teaspill/schema's canonical addressing patterns (0002:T1.1 —
// promoted out of a local port that used to live here, https://teaspill.everynow.dev/reference/addressing).

/** `/api/…` path prefix for a target (short form or tenant-qualified). */
export function entityApiPath(target: EntityTarget): string {
  if (typeof target !== "string") {
    if (!TYPE_RE.test(target.type))
      throw new Error(`invalid entity type: ${JSON.stringify(target.type)}`);
    if (!ID_RE.test(target.id)) throw new Error(`invalid entity id: ${JSON.stringify(target.id)}`);
    return `/api/a/${target.type}/${target.id}`;
  }
  const short = SHORT_FORM_RE.exec(target);
  if (short !== null) return `/api/a/${short[1]}/${short[2]}`;
  const canonical = ENTITY_URL_RE.exec(target);
  if (canonical !== null) return `/api/t/${canonical[1]}/a/${canonical[2]}/${canonical[3]}`;
  throw new Error(
    `not an entity target: ${JSON.stringify(target)} (expected {type,id}, "/a/<type>/<id>", or "/t/<tenant>/a/<type>/<id>")`,
  );
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createActionsClient(options: ActionsClientOptions): ActionsClient {
  const base = String(options.baseUrl).replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;

  async function post(path: string, body: unknown, opts?: RequestOptions): Promise<ActionAccepted> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(await resolveAuthHeader(options.auth)),
    };
    if (opts?.idempotencyKey !== undefined) headers["idempotency-key"] = opts.idempotencyKey;
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const resBody: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const message =
        typeof resBody === "object" && resBody !== null && "error" in resBody
          ? String((resBody as { error: unknown }).error)
          : undefined;
      throw new GatewayActionError(res.status, resBody, message);
    }
    return resBody as ActionAccepted;
  }

  const control = (
    target: EntityTarget,
    verb: ControlVerb,
    reason?: string,
    opts?: RequestOptions,
  ): Promise<ActionAccepted> =>
    post(
      `${entityApiPath(target)}/control`,
      { verb, ...(reason !== undefined ? { reason } : {}) },
      opts,
    );

  return {
    spawn: (request, opts) =>
      post(
        "/api/spawn",
        {
          type: request.type,
          ...(request.id !== undefined ? { id: request.id } : {}),
          ...(request.args !== undefined ? { args: request.args } : {}),
          ...(request.parent !== undefined ? { parent: request.parent } : {}),
        },
        opts,
      ),
    send: (target, message, opts) => post(`${entityApiPath(target)}/send`, message, opts),
    control,
    interrupt: (target, reason, opts) => control(target, "interrupt", reason, opts),
    pause: (target, opts) => control(target, "pause", undefined, opts),
    resume: (target, opts) => control(target, "resume", undefined, opts),
    archive: (target, opts) => control(target, "archive", undefined, opts),
  };
}
