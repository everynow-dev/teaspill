/**
 * `teaspill agents ls | spawn | send | control` (T6.2).
 *
 * Thin consumers of the frontend-sdk clients (T5.2): `agents ls` reads the
 * catalog over Electric shapes; `spawn`/`send`/`control` drive the actions
 * client through the gateway `/api/*`. No stream reading or HTTP is
 * reimplemented here.
 */

import type { ControlVerb, JsonValue } from "@teaspill/schema";
import type { CatalogFilter, EntityStatus, TeaspillAuth } from "@teaspill/frontend-sdk";
import type { CliDeps } from "../deps.js";
import type { ResolvedConfig } from "../config.js";

const CONTROL_VERBS: readonly ControlVerb[] = ["interrupt", "pause", "resume", "archive"];

function authFor(config: ResolvedConfig): TeaspillAuth | undefined {
  return config.apiKey !== undefined ? { apiKey: config.apiKey } : undefined;
}

/** Parse a positional/flag JSON argument; falls back to a bare string. */
export function parseJsonArg(raw: string | undefined): JsonValue | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    // A bare word/sentence is a valid string message.
    return raw;
  }
}

export interface AgentsLsFlags {
  type?: string;
  status?: string;
  parent?: string;
  tenant?: string;
  json?: boolean;
}

export async function agentsLs(
  deps: CliDeps,
  config: ResolvedConfig,
  flags: AgentsLsFlags = {},
): Promise<void> {
  const filter: CatalogFilter = {};
  if (flags.type !== undefined) filter.type = flags.type;
  if (flags.status !== undefined) filter.status = flags.status as EntityStatus;
  if (flags.parent !== undefined) filter.parent = flags.parent;
  filter.tenant = flags.tenant ?? config.tenant;

  const auth = authFor(config);
  const catalog = deps.createAgentCatalog({
    baseUrl: config.gatewayUrl,
    filter,
    ...(auth !== undefined ? { auth } : {}),
  });
  try {
    const state = await catalog.untilReady();
    if (state.lastError !== null && state.lastError !== undefined) {
      throw state.lastError;
    }
    if (flags.json === true) {
      deps.io.out(JSON.stringify(state.rows, null, 2));
      return;
    }
    if (state.rows.length === 0) {
      deps.io.out("(no entities)");
      return;
    }
    for (const r of state.rows) {
      const head = r.headSeq !== null ? `head=${r.headSeq}` : "head=-";
      deps.io.out(`${r.status.padEnd(8)} ${r.url}  (${r.type}) ${head}`);
    }
  } finally {
    catalog.close();
  }
}

export interface SpawnFlags {
  id?: string;
  parent?: string;
  args?: string;
  idempotencyKey?: string;
}

export async function spawnAgent(
  deps: CliDeps,
  config: ResolvedConfig,
  type: string,
  positionalArgs: string | undefined,
  flags: SpawnFlags = {},
): Promise<void> {
  const auth = authFor(config);
  const client = deps.createActionsClient({
    baseUrl: config.gatewayUrl,
    ...(auth !== undefined ? { auth } : {}),
  });
  const args = parseJsonArg(flags.args ?? positionalArgs);
  const accepted = await client.spawn(
    {
      type,
      ...(flags.id !== undefined ? { id: flags.id } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(flags.parent !== undefined ? { parent: flags.parent } : {}),
    },
    flags.idempotencyKey !== undefined ? { idempotencyKey: flags.idempotencyKey } : undefined,
  );
  deps.io.out(`spawned ${accepted.url}`);
  deps.io.out(`  logs: teaspill logs ${accepted.url}`);
}

export async function sendMessage(
  deps: CliDeps,
  config: ResolvedConfig,
  target: string,
  message: string,
  flags: { idempotencyKey?: string } = {},
): Promise<void> {
  const auth = authFor(config);
  const client = deps.createActionsClient({
    baseUrl: config.gatewayUrl,
    ...(auth !== undefined ? { auth } : {}),
  });
  const payload = parseJsonArg(message);
  const accepted = await client.send(
    target,
    payload ?? message,
    flags.idempotencyKey !== undefined ? { idempotencyKey: flags.idempotencyKey } : undefined,
  );
  deps.io.out(`sent → ${accepted.url}`);
}

export async function controlAgent(
  deps: CliDeps,
  config: ResolvedConfig,
  target: string,
  verb: string,
  flags: { reason?: string } = {},
): Promise<void> {
  if (!CONTROL_VERBS.includes(verb as ControlVerb)) {
    throw new Error(
      `unknown control verb ${JSON.stringify(verb)} — expected one of ${CONTROL_VERBS.join(", ")}`,
    );
  }
  const auth = authFor(config);
  const client = deps.createActionsClient({
    baseUrl: config.gatewayUrl,
    ...(auth !== undefined ? { auth } : {}),
  });
  const accepted = await client.control(target, verb as ControlVerb, flags.reason);
  deps.io.out(`${verb} → ${accepted.url}`);
}
