/**
 * Harness selection (T6.1) — `native(...)` and `claudeAgentSdk(...)`.
 *
 * A developer's `defineAgent({ harness })` names ONE harness via these
 * builders. Each returns a `HarnessSpec` — a thin descriptor `defineAgent`
 * finalizes (with the developer's extra tools) into a `HarnessSelection` that
 * compiles onto the coordination agent-object template (agent.ts
 * `AgentObjectConfig`):
 *
 * - **`native(config)`** → the step-durable pi-ai harness (D5 gold standard,
 *   T3.2). It compiles to `AgentObjectConfig.buildHarness` (the T6.1
 *   run-boundary resolution): per wake the coordination handler builds a
 *   `createPiHarness` bound to the live invocation's ctx (its journaled-step
 *   seam), wired with the platform tools (T3.3) + workspace tools (T4.3) + the
 *   developer's tools, each routed through a `ToolContext` carrying the
 *   exactly-once idempotency key `(entityUrl, runId, toolUseId)` (T3.1
 *   invariant 1). The harness authors its own `run_started`/`run_finished`
 *   (`emitRunBoundaries`), threading the true wake source (gap b) and seeding
 *   its budget from the prior run's `contextTokens` (gap c) — both supplied by
 *   the handler through `HarnessBuildContext`.
 * - **`claudeAgentSdk(config)`** → a TYPED SELECTION STUB. Selecting it is
 *   valid and type-checked, but building/running it throws a clear
 *   "CASDK harness not yet available (T7.1)". T6.1 does NOT implement CASDK.
 */

import type { KnownProvider, Model, Api, ThinkingLevel } from "@mariozechner/pi-ai";
import type { JsonValue } from "@teaspill/schema";
import type {
  AnyToolDefinition,
  Harness,
  PiStepClient,
  PlatformClient,
  SendRequest,
  SpawnRequest,
  ToolContext,
  ToolContextFactory,
  WorkspaceClient,
} from "@teaspill/harness-native";
import {
  createPiAiStepClient,
  createPiHarness,
  platformTools,
  workspaceTools,
  type PlatformToolName,
  type WorkspaceToolName,
} from "@teaspill/harness-native";
import type { HarnessBuildContext } from "@teaspill/coordination";

// ===========================================================================
// Selection shape
// ===========================================================================

export type HarnessKind = "native" | "casdk";

/**
 * A finalized harness selection: the descriptor `Harness` (names the kind for
 * `run_started`/registration), the assembled tool list, and — for a
 * step-durable harness — the per-wake `buildHarness` the agent-object template
 * calls. `buildHarness` is absent for the CASDK stub (whose `harness.run`
 * throws at runtime).
 */
export interface HarnessSelection {
  readonly kind: HarnessKind;
  readonly tools: AnyToolDefinition[];
  readonly harness: Harness;
  readonly buildHarness?: (build: HarnessBuildContext) => Harness;
}

/**
 * A harness choice, before the developer's extra tools are known. `defineAgent`
 * calls `finalize(userTools)` to produce the `HarnessSelection`.
 */
export interface HarnessSpec {
  readonly kind: HarnessKind;
  finalize(userTools: readonly AnyToolDefinition[]): HarnessSelection;
}

// ===========================================================================
// Tool-context wiring (T3.1 invariant 1)
// ===========================================================================

/**
 * Builds the per-tool-call `ToolContext` (the clients + bound idempotency key).
 * Injected so the concrete ingress transport (and, in tests, fakes) live
 * outside the harness. `native(...)` provides an HTTP-ingress default; a
 * deployment or test can override it wholesale.
 */
export type ToolContextBuilder = (build: HarnessBuildContext) => ToolContextFactory;

/** Parse the tenant + type out of a canonical entity url `/t/<tenant>/a/<type>/<id>`. */
function parseEntityUrl(url: string): { tenant: string; type: string; id: string } | null {
  const m = /^\/t\/([a-z0-9][a-z0-9_-]*)\/a\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/.exec(url);
  return m ? { tenant: m[1]!, type: m[2]!, id: m[3]! } : null;
}

export interface HttpToolClientsOptions {
  /**
   * Restate ingress base url, e.g. `http://restate:8080`. Required for
   * `spawn_agent`/`send_message` to reach other agents; absent ⇒ those tools
   * return a clear model-visible error (control tools still work — they touch
   * no client). See docs/self-hosting-networking.md.
   */
  ingressUrl?: string;
  fetch?: typeof fetch;
  /** Extra headers (e.g. gateway auth) on every ingress call. */
  headers?: Record<string, string>;
  /** Optional workspace-client factory (T4.x executor wiring); omit for no workspace. */
  workspace?: (build: HarnessBuildContext) => WorkspaceClient | undefined;
}

/**
 * The default HTTP-ingress `ToolContextBuilder`. The platform client issues a
 * raw idempotency-keyed Restate ingress POST per side effect (the same
 * "network call inside `ctx.run`" shape as `createHttpSteerSource`); the tool
 * step it runs inside is journaled, so a step retry replays the identical key
 * and Restate's ingress dedup makes the effect happen once (T3.1 invariant 1).
 */
export function httpToolContext(opts: HttpToolClientsOptions = {}): ToolContextBuilder {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = opts.ingressUrl?.replace(/\/$/, "");

  const post = async (path: string, body: JsonValue, idempotencyKey: string): Promise<void> => {
    if (base === undefined) {
      throw new Error(
        "platform ingress not configured — pass native({ ingressUrl }) to enable spawn_agent/send_message",
      );
    }
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        ...opts.headers,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ingress POST ${path} failed: ${res.status} ${text}`);
    }
  };

  return (build) => {
    const self = parseEntityUrl(build.entityId);
    const tenant = self?.tenant ?? "default";
    return (binding): ToolContext => {
      const platform: PlatformClient = {
        async spawn(req: SpawnRequest): Promise<{ entityId: string }> {
          const childId = req.id ?? `${req.entityType}-${cryptoRandomId()}`;
          const entityId = `/t/${tenant}/a/${req.entityType}/${childId}`;
          await post(
            `/agent.${req.entityType}/${encodeURIComponent(childId)}/spawn`,
            {
              ...(req.args !== undefined && { args: req.args }),
              parentRef: build.entityId,
              ...(req.workspaceRef !== undefined && { workspaceRef: req.workspaceRef }),
            },
            binding.idempotencyKey,
          );
          return { entityId };
        },
        async send(req: SendRequest): Promise<void> {
          const target = parseEntityUrl(req.to);
          if (!target) throw new Error(`send: not a canonical entity url: ${JSON.stringify(req.to)}`);
          if (req.mode === "steer") {
            await post(
              `/steer/${encodeURIComponent(req.to)}/push`,
              { content: req.content },
              binding.idempotencyKey,
            );
            return;
          }
          await post(
            `/agent.${target.type}/${encodeURIComponent(target.id)}/message`,
            { kind: "message", content: req.content, from: build.entityId },
            binding.idempotencyKey,
          );
        },
        // Catalog read (D1) is a deployment seam; unwired here ⇒ empty list.
        async listChildren() {
          return [];
        },
      };
      const workspace = opts.workspace?.(build);
      return {
        entityUrl: binding.entityUrl,
        runId: binding.runId,
        toolUseId: binding.toolUseId,
        idempotencyKey: binding.idempotencyKey,
        signal: binding.signal,
        platform,
        ...(workspace !== undefined && { workspace }),
      };
    };
  };
}

function cryptoRandomId(): string {
  // Inside a journaled tool step ⇒ the result is captured and stable on replay.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ===========================================================================
// native(...)
// ===========================================================================

export interface NativeHarnessConfig {
  /** pi-ai model id (e.g. `claude-sonnet-4-5`) or a full `Model` object. */
  model: string | Model<Api>;
  /** Provider for string model ids. Default `anthropic`. */
  provider?: KnownProvider;
  /** API-level system prompt (never timeline history). */
  systemPrompt?: string;
  /** API key or resolver; omitted → pi-ai env-var conventions. */
  apiKey?: string | ((provider: string) => string | undefined | Promise<string | undefined>);
  reasoning?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  /** Cache-inclusive context budget; crossing it triggers summarization. */
  contextBudgetTokens?: number;
  /** Hard cap on LLM steps per run. */
  maxSteps?: number;
  /** Include the platform tools (T3.3). `true`/omit = all; a subset via `include`; `false` = none. */
  platform?: boolean | { include?: readonly PlatformToolName[] };
  /** Include the workspace tools (T4.3). `false` (default) = none unless a workspace is wired. */
  workspace?: boolean | { include?: readonly WorkspaceToolName[] };
  /**
   * Restate ingress base url for the default tool-client transport (spawn/send).
   * Passed straight to `httpToolContext`. Omit for control-only agents/tests.
   */
  ingressUrl?: string;
  /** Extra ingress headers (auth). */
  ingressHeaders?: Record<string, string>;
  /**
   * Advanced/test seam: inject the `PiStepClient` (skip building one from
   * `model`). The end-to-end tests pass a scripted fake here.
   */
  client?: PiStepClient;
  /**
   * Advanced/test seam: override the whole tool-context builder (the tests
   * inject a fake with no network).
   */
  toolContext?: ToolContextBuilder;
}

function selectPlatformTools(cfg: NativeHarnessConfig["platform"]): AnyToolDefinition[] {
  if (cfg === false) return [];
  if (cfg === undefined || cfg === true) return platformTools();
  return platformTools(cfg.include ? { include: cfg.include } : {});
}

function selectWorkspaceTools(cfg: NativeHarnessConfig["workspace"]): AnyToolDefinition[] {
  if (cfg === undefined || cfg === false) return [];
  if (cfg === true) return workspaceTools();
  return workspaceTools(cfg.include ? { include: cfg.include } : {});
}

export function native(config: NativeHarnessConfig): HarnessSpec {
  return {
    kind: "native",
    finalize(userTools): HarnessSelection {
      const tools: AnyToolDefinition[] = [
        ...selectPlatformTools(config.platform),
        ...selectWorkspaceTools(config.workspace),
        ...userTools,
      ];
      // Built LAZILY on first run (memoized): the step client is stateless
      // across wakes, but resolving the model must NOT happen at
      // definition/registration time (compile + register need no provider).
      let client = config.client;
      const getClient = (): PiStepClient =>
        (client ??= createPiAiStepClient({
          model: config.model,
          ...(config.provider !== undefined && { provider: config.provider }),
          ...(config.apiKey !== undefined && { apiKey: config.apiKey }),
          ...(config.reasoning !== undefined && { reasoning: config.reasoning }),
          ...(config.temperature !== undefined && { temperature: config.temperature }),
          ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
        }));

      const buildToolContext =
        config.toolContext ??
        httpToolContext({
          ...(config.ingressUrl !== undefined && { ingressUrl: config.ingressUrl }),
          ...(config.ingressHeaders !== undefined && { headers: config.ingressHeaders }),
        });

      // Descriptor: names the kind for run_started/registration; never .run().
      const descriptor: Harness = {
        kind: "native",
        run() {
          throw new Error(
            "native harness descriptor is not runnable directly — the agent object builds it per wake via buildHarness",
          );
        },
      };

      const buildHarness = (build: HarnessBuildContext): Harness =>
        createPiHarness({
          ctx: build.ctx, // AgentRuntimeCtx satisfies HarnessCtx (has `run`)
          client: getClient(),
          toolContext: buildToolContext(build),
          emitRunBoundaries: true, // gap a — the harness owns the run boundaries
          wakeSource: build.wakeSource, // gap b
          ...(build.wakeFrom !== undefined && { wakeFrom: build.wakeFrom }),
          ...(build.priorContextTokens !== undefined && {
            initialContextTokens: build.priorContextTokens, // gap c
          }),
          ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
          ...(config.contextBudgetTokens !== undefined && {
            contextBudgetTokens: config.contextBudgetTokens,
          }),
          ...(config.maxSteps !== undefined && { maxSteps: config.maxSteps }),
        });

      return { kind: "native", tools, harness: descriptor, buildHarness };
    },
  };
}

// ===========================================================================
// claudeAgentSdk(...) — typed selection stub (T7.1 implements for real)
// ===========================================================================

export interface ClaudeAgentSdkConfig {
  /** Model id (e.g. `claude-sonnet-4-5`). */
  model: string;
  systemPrompt?: string;
  /** Session-store / durable-session location key (D5 layer 2) — recorded, unused until T7.1. */
  sessionStore?: string;
}

export const CASDK_NOT_AVAILABLE =
  "CASDK harness not yet available (T7.1). claudeAgentSdk(...) is a typed selection only; " +
  "use native(...) until the Claude Agent SDK harness lands.";

export function claudeAgentSdk(config: ClaudeAgentSdkConfig): HarnessSpec {
  void config;
  return {
    kind: "casdk",
    finalize(userTools): HarnessSelection {
      const tools: AnyToolDefinition[] = [
        ...platformTools(),
        ...workspaceTools(),
        ...userTools,
      ];
      const descriptor: Harness = {
        kind: "casdk",
        run() {
          throw new Error(CASDK_NOT_AVAILABLE);
        },
      };
      // No `buildHarness`: selecting CASDK compiles cleanly, but any attempt to
      // RUN it throws the clear message above (via the descriptor).
      return { kind: "casdk", tools, harness: descriptor };
    },
  };
}
