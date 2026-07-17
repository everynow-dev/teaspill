/**
 * The injected SDK seam (T7.1) — everything the harness needs from
 * `@anthropic-ai/claude-agent-sdk`, expressed structurally so the harness
 * tests offline against a fake and the real SDK loads lazily only when a
 * real run happens.
 *
 * Types mirror the PINNED SDK (`@anthropic-ai/claude-agent-sdk@0.3.211`,
 * bundled CLI 2.1.211 — exact-pinned in package.json, never `^`). They are
 * deliberately a structural SUBSET: unknown record types flow through as
 * `SdkStreamRecord` and become canonical `opaque` events (R3 churn valve,
 * translation.ts).
 */

import type { SessionLine } from "./session-lines.js";

export const PINNED_SDK_VERSION = "0.3.211";

// ---------------------------------------------------------------------------
// Stream records (SDK → harness), structural subset of `SDKMessage`
// ---------------------------------------------------------------------------

export interface SdkUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** Any record from the query output stream. Narrow with the guards below. */
export type SdkStreamRecord = { type: string; subtype?: string; [k: string]: unknown };

export interface SdkInitRecord extends SdkStreamRecord {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  permissionMode?: string;
}

export interface SdkCompactBoundaryRecord extends SdkStreamRecord {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: { trigger: string; pre_tokens: number; [k: string]: unknown };
}

export interface SdkAssistantRecord extends SdkStreamRecord {
  type: "assistant";
  message: { id?: string; content: unknown; usage?: SdkUsage; model?: string };
  parent_tool_use_id: string | null;
}

export interface SdkUserRecord extends SdkStreamRecord {
  type: "user";
  message: { role: "user"; content: unknown };
  parent_tool_use_id?: string | null;
  isSynthetic?: boolean;
  /** Structured tool output (per-tool shape) — feeds tool_result detail when present. */
  tool_use_result?: unknown;
}

export interface SdkPartialRecord extends SdkStreamRecord {
  type: "stream_event";
  event: { type: string; [k: string]: unknown };
  parent_tool_use_id?: string | null;
}

export interface SdkResultRecord extends SdkStreamRecord {
  type: "result";
  subtype: string; // 'success' | 'error_during_execution' | 'error_max_turns' | ...
  usage?: SdkUsage;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  result?: string;
  errors?: string[];
  session_id?: string;
}

export const isInit = (m: SdkStreamRecord): m is SdkInitRecord =>
  m.type === "system" && m.subtype === "init";
export const isCompactBoundary = (m: SdkStreamRecord): m is SdkCompactBoundaryRecord =>
  m.type === "system" && m.subtype === "compact_boundary";
export const isAssistant = (m: SdkStreamRecord): m is SdkAssistantRecord => m.type === "assistant";
export const isUser = (m: SdkStreamRecord): m is SdkUserRecord => m.type === "user";
export const isPartial = (m: SdkStreamRecord): m is SdkPartialRecord => m.type === "stream_event";
export const isResult = (m: SdkStreamRecord): m is SdkResultRecord => m.type === "result";
export const isMirrorError = (m: SdkStreamRecord): boolean =>
  m.type === "system" && m.subtype === "mirror_error";

// ---------------------------------------------------------------------------
// Streaming input (harness → SDK)
// ---------------------------------------------------------------------------

/** The user-message frame fed into a streaming-input `query()` prompt. */
export interface SdkUserInputMessage {
  type: "user";
  message: { role: "user"; content: unknown };
  parent_tool_use_id: null;
  session_id?: string;
}

// ---------------------------------------------------------------------------
// SessionStore facade shape (the SDK's `@alpha` SessionStore contract)
// ---------------------------------------------------------------------------

export interface SdkSessionKey {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}

/** Structural match for the SDK's `SessionStore` (`@alpha` in 0.3.211). */
export interface SdkSessionStoreLike {
  load(key: SdkSessionKey): Promise<SessionLine[] | null>;
  append(key: SdkSessionKey, entries: SessionLine[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Query options + client seam
// ---------------------------------------------------------------------------

/**
 * The exact option surface the harness uses — the spike-verified minimum
 * headless configuration (digest §1.4):
 * - `tools: []` is the AUTHORITATIVE built-in disable (`allowedTools` alone
 *   only auto-approves; omitting `tools` enables the full claude_code preset);
 * - `settingSources: []` keeps user-config hooks/settings out of the session;
 * - `permissionMode: 'bypassPermissions'` — we own the whole toolset;
 * - no built-in subagents are ever configured;
 * - `systemPrompt` is a fully custom bare string (replaces the preset);
 * - `includePartialMessages` drives the delta channel.
 */
export interface CasdkQueryOptions {
  model: string;
  systemPrompt: string;
  tools: string[];
  permissionMode: "bypassPermissions";
  settingSources: never[];
  resume?: string;
  sessionStore?: SdkSessionStoreLike;
  sessionStoreFlush?: "batched" | "eager";
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  includePartialMessages?: boolean;
  abortController: AbortController;
  maxTurns?: number;
  /** SDK hook config — observers only (PostCompact summary capture). */
  hooks?: Record<string, unknown>;
  env?: Record<string, string>;
  cwd?: string;
}

export interface CasdkQueryInput {
  prompt: string | AsyncIterable<SdkUserInputMessage>;
  options: CasdkQueryOptions;
}

/**
 * The query seam. Real implementation: `createClaudeAgentSdkClient()`
 * (lazy-imports the pinned SDK). Tests inject a scripted fake
 * (`createFakeSdkClient` in harness.test.ts).
 */
export interface CasdkSdkClient {
  query(input: CasdkQueryInput): AsyncIterable<SdkStreamRecord>;
}

/**
 * Real SDK client. The import happens on first `query()` call, so merely
 * constructing a harness (or running offline tests) never loads the SDK/CLI.
 */
export function createClaudeAgentSdkClient(): CasdkSdkClient {
  return {
    query(input: CasdkQueryInput): AsyncIterable<SdkStreamRecord> {
      async function* run(): AsyncGenerator<SdkStreamRecord> {
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        const q = sdk.query({
          prompt: input.prompt as never,
          options: input.options as never,
        });
        for await (const msg of q) {
          yield msg as unknown as SdkStreamRecord;
        }
      }
      return run();
    },
  };
}
