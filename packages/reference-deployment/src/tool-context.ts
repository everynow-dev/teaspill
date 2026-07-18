/**
 * The reference `ToolContextBuilder` (0002:T4.1) — the REAL ingress tool
 * clients 0001:T6.2 left as deployment seams.
 *
 * Composes `httpToolContext` (`@teaspill/agents-sdk` — the idempotency-keyed
 * raw-ingress spawn/send transport, 0001:T3.1 invariant 1) and completes the
 * two seams it deliberately left unwired:
 *
 *  1. **`listChildren` real impl** — a catalog read through the
 *     `ChildrenStore` seam (./children.ts). The same wrapper records the
 *     parent linkage at `spawn` time (best-effort, idempotent — see
 *     children.ts for why the platform never wrote `entities.parent`).
 *  2. **Workspace client** — a per-tool-call concrete ingress
 *     `WorkspaceClient` (./workspace-client.ts) bound to the invocation's
 *     idempotency key and the entity's workspace: the SPAWN-CHOSEN
 *     `workspaceRef` when one was set (0001:D4 — now exposed on
 *     `HarnessBuildContext.workspaceRef`, additive 0002:T4.2, closing the
 *     0002:T4.1 reachability flag), else the derived PRIVATE workspace key
 *     (`privateWorkspaceKey(entityUrl)`, addressing §5).
 *
 * Both demo harnesses (`native(...)` and `claudeAgentSdk(...)`) accept this
 * builder via their `toolContext` option.
 */

import type { ToolContextBuilder } from "@teaspill/agents-sdk";
import { httpToolContext } from "@teaspill/agents-sdk";
import type { PlatformClient, ToolContext } from "@teaspill/harness-native";
import type { WorkspaceEnsureConfig } from "@teaspill/executor";
import { privateWorkspaceKey } from "@teaspill/schema";
import type { ChildrenStore } from "./children.js";
import { createIngressWorkspaceClient } from "./workspace-client.js";

export interface ReferenceToolContextOptions {
  /** Restate ingress base url as seen from the agent-loop process. */
  ingressUrl: string;
  fetch?: typeof fetch;
  /** Extra headers on every ingress call. */
  headers?: Record<string, string>;
  /**
   * Catalog-backed children store. Absent ⇒ `listChildren` returns `[]` (the
   * pre-0002 unwired behavior) — wire `createDrizzleChildrenStore(db)` in any
   * real deployment.
   */
  children?: ChildrenStore;
  /**
   * Wire workspace tools: the ensure config every private workspace is
   * created with (e.g. `{ adapter: "docker" }`). Absent ⇒ no workspace client
   * (workspace tools answer "this agent has no workspace").
   */
  workspace?: { ensure: WorkspaceEnsureConfig };
  /** Best-effort failure observer (parent-linkage record, abort→kill). Default: console.warn. */
  onSoftError?: (context: string, err: unknown) => void;
}

export function createReferenceToolContext(opts: ReferenceToolContextOptions): ToolContextBuilder {
  const softError =
    opts.onSoftError ??
    ((context: string, err: unknown) =>
      console.warn(`[reference-deployment] ${context}: ${String(err)}`));
  const base = httpToolContext({
    ingressUrl: opts.ingressUrl,
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.headers !== undefined && { headers: opts.headers }),
  });

  return (build) => {
    const inner = base(build);
    return (binding): ToolContext => {
      const ctx = inner(binding);
      const platform: PlatformClient = {
        async spawn(req) {
          const out = await ctx.platform.spawn(req);
          if (opts.children) {
            try {
              // Same journaled tool step as the spawn send; idempotent
              // set-once upsert. Best-effort: linkage failure must never fail
              // the spawn (the durable send already happened).
              await opts.children.recordSpawn({ childUrl: out.entityId, parentUrl: build.entityId });
            } catch (err) {
              softError(`recordSpawn(${out.entityId})`, err);
            }
          }
          return out;
        },
        send: (req) => ctx.platform.send(req),
        listChildren: async () =>
          opts.children ? opts.children.listChildren(build.entityId) : [],
      };

      const workspace = opts.workspace
        ? createIngressWorkspaceClient({
            ingressUrl: opts.ingressUrl,
            // Spawn-chosen workspace (agent K/V, 0001:D4) wins; derived
            // private workspace is the default (0002:T4.2).
            workspaceRef: build.workspaceRef ?? privateWorkspaceKey(build.entityId),
            ensure: opts.workspace.ensure,
            idempotencyKey: binding.idempotencyKey,
            ...(opts.fetch !== undefined && { fetch: opts.fetch }),
            ...(opts.headers !== undefined && { headers: opts.headers }),
            onKillError: (err) => softError("exec abort→kill", err),
          })
        : undefined;

      return { ...ctx, platform, ...(workspace !== undefined && { workspace }) };
    };
  };
}
