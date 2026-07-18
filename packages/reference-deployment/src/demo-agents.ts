/**
 * Env-gated demo agents (0002:T4.1): one real pi-harness (`native`) agent and
 * one Claude-Agent-SDK (`claudeAgentSdk`) agent, showing the full
 * `defineAgent` surface with the reference tool clients (platform +
 * workspace tools wired through ./tool-context.ts).
 *
 * ## Gating (never crash the loop)
 *
 * Both agents need `ANTHROPIC_API_KEY`; the CASDK agent additionally needs
 * the `@anthropic-ai/claude-agent-sdk` runtime present (it is `--external` in
 * the docker bundle — see the README) and so is opt-in via
 * `TEASPILL_DEMO_CASDK=1`. A missing prerequisite means the agent is simply
 * NOT BUILT (it is not served, not registered) and the reason is returned in
 * `skipped` for the bootstrap to log — the deterministic conformance agents
 * always serve regardless.
 */

import { z } from "zod";
import {
  claudeAgentSdk,
  defineAgent,
  native,
  type AgentDefinition,
  type ToolContextBuilder,
} from "@teaspill/agents-sdk";

export const DEMO_TYPES = {
  pi: "demo-pi",
  casdk: "demo-casdk",
} as const;

export interface DemoAgentOptions {
  /** The reference tool-context builder (real ingress clients). */
  toolContext: ToolContextBuilder;
  /** `ANTHROPIC_API_KEY`; absent ⇒ both demo agents are skipped. */
  anthropicApiKey?: string;
  /** Serve the CASDK demo agent (`TEASPILL_DEMO_CASDK=1`). Default false. */
  casdkEnabled?: boolean;
  /** Model id for both demos. Default `claude-sonnet-4-5`. */
  model?: string;
  /** CASDK durable session-store dir (0001:D5 warm resume). Default memory store. */
  casdkSessionDir?: string;
}

export interface DemoAgentsBuild {
  definitions: AgentDefinition[];
  skipped: Array<{ type: string; reason: string }>;
}

const demoState = z.object({ notes: z.array(z.string()).optional() });
const demoSpawnSchema = z.object({ task: z.string().optional() });

const DEMO_SYSTEM_PROMPT =
  "You are a teaspill demo agent. You have platform tools (spawn_agent, send_message, " +
  "list_children, finish) and workspace tools (bash, read_file, write_file, edit_file, ls) " +
  "backed by a real containerized workspace. Be concise; use tools when asked to act.";

export function buildDemoAgents(opts: DemoAgentOptions): DemoAgentsBuild {
  const definitions: AgentDefinition[] = [];
  const skipped: DemoAgentsBuild["skipped"] = [];
  const model = opts.model ?? "claude-sonnet-4-5";

  if (opts.anthropicApiKey === undefined || opts.anthropicApiKey === "") {
    skipped.push(
      { type: DEMO_TYPES.pi, reason: "ANTHROPIC_API_KEY not set" },
      { type: DEMO_TYPES.casdk, reason: "ANTHROPIC_API_KEY not set" },
    );
    return { definitions, skipped };
  }

  definitions.push(
    defineAgent({
      type: DEMO_TYPES.pi,
      spawnSchema: demoSpawnSchema,
      state: demoState,
      harness: native({
        model,
        provider: "anthropic",
        apiKey: opts.anthropicApiKey,
        systemPrompt: DEMO_SYSTEM_PROMPT,
        platform: true,
        workspace: true,
        toolContext: opts.toolContext,
      }),
    }),
  );

  if (opts.casdkEnabled === true) {
    definitions.push(
      defineAgent({
        type: DEMO_TYPES.casdk,
        spawnSchema: demoSpawnSchema,
        state: demoState,
        harness: claudeAgentSdk({
          model,
          systemPrompt: DEMO_SYSTEM_PROMPT,
          platform: true,
          workspace: true,
          toolContext: opts.toolContext,
          ...(opts.casdkSessionDir !== undefined && { sessionStore: opts.casdkSessionDir }),
        }),
      }),
    );
  } else {
    skipped.push({
      type: DEMO_TYPES.casdk,
      reason: "TEASPILL_DEMO_CASDK not enabled (the SDK runtime is external to the docker bundle)",
    });
  }

  return { definitions, skipped };
}
