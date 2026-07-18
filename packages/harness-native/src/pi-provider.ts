/**
 * pi-ai step client (0001:T3.2) — the real multi-provider `PiStepClient` over
 * `@mariozechner/pi-ai` (pinned; see package.json).
 *
 * One `step()` = one `streamSimple`/`completeSimple` call = one assistant
 * turn — pi-ai's per-call API gives every provider a clean step boundary by
 * construction, which is what lets the harness journal each LLM call as its
 * own `ctx.run` (electric's pi-adapter drove `@mariozechner/pi-agent-core`'s
 * `Agent`, which owns the whole multi-step loop internally — incompatible
 * with per-step journaling, so teaspill drives pi-ai directly and owns the
 * loop in pi-harness.ts; the event/usage mapping shape is lifted from
 * pi-adapter.ts).
 *
 * ## Streaming vs buffered (PLAN 0001:T3.2 "Anticipate")
 *
 * Default is STREAMED for every provider (`streamSimple`), forwarding
 * text/thinking/tool-input fragments to the harness's delta channel. If a
 * provider's streaming proves unreliable, flip it to BUFFERED
 * (`completeSimple`) via `buffered: true` or the `BUFFERED_PROVIDERS` set —
 * the journal granularity is IDENTICAL either way (the journaled unit is the
 * completed turn); buffering only silences the ephemeral delta channel. No
 * provider is buffered by default yet — the set exists so soak-test findings
 * become a one-line change.
 *
 * ## Error contract
 *
 * Rejections follow pi-client.ts: aborts reject abort-shaped (the harness
 * maps them to `interrupted`); everything else rejects as a classified
 * `PiProviderError` (retryable → the harness rethrows out of the journaled
 * step so Restate retries it; terminal → journaled + canonical
 * `error(source:'provider')`). pi-ai's own client-side `maxRetries` (default
 * 2) runs UNDER Restate's step retry — both layers respect the same
 * abort signal.
 */

import {
  completeSimple,
  getModel,
  streamSimple,
  type Api,
  type AssistantMessage,
  type Context,
  type KnownProvider,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type Tool,
  type Usage,
} from "@mariozechner/pi-ai";
import type { JsonValue } from "@teaspill/schema";
import {
  toPiProviderError,
  type PiHistoryMessage,
  type PiStepClient,
  type PiStepRequest,
  type PiStepTurn,
  type PiTurnBlock,
  type PiTurnUsage,
} from "./pi-client.js";

/**
 * Providers forced to buffered (non-streamed) calls. Empty today — every
 * pi-ai provider yields clean per-call step boundaries; populate from real
 * soak findings (see module header).
 */
export const BUFFERED_PROVIDERS: ReadonlySet<string> = new Set<string>();

export interface PiAiStepClientOptions {
  /** pi-ai model id (e.g. `claude-sonnet-4-5`) or a full `Model` object. */
  model: string | Model<Api>;
  /** Provider for string model ids. Default `anthropic`. */
  provider?: KnownProvider;
  /**
   * API key, or a resolver by provider name. Omitted → pi-ai falls back to
   * its provider env-var conventions.
   */
  apiKey?: string | ((provider: string) => string | undefined | Promise<string | undefined>);
  /** Request timeout per LLM call. Default 60s. */
  timeoutMs?: number;
  /** pi-ai client-side retries per call (under Restate's step retry). Default 2. */
  maxRetries?: number;
  reasoning?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  /** Force buffered (non-streamed) calls for this client. */
  buffered?: boolean;
  /** Extra HTTP headers (provider permitting). */
  headers?: Record<string, string>;
  /** Test seams — default to pi-ai's `streamSimple`/`completeSimple`. */
  streamFn?: typeof streamSimple;
  completeFn?: typeof completeSimple;
}

export const DEFAULT_STEP_TIMEOUT_MS = 60_000;
export const DEFAULT_STEP_MAX_RETRIES = 2;

/** Resolve a model spec to a pi-ai `Model` (electric `resolvePiModel` shape). */
export function resolvePiAiModel(opts: {
  model: string | Model<Api>;
  provider?: KnownProvider;
}): Model<Api> {
  if (typeof opts.model !== "string") return opts.model;
  const provider = opts.provider ?? "anthropic";
  const model = getModel(provider, opts.model as never) as Model<Api> | undefined;
  if (!model) {
    throw new Error(
      `createPiAiStepClient: unknown model ${JSON.stringify(opts.model)} for provider ${JSON.stringify(provider)}`,
    );
  }
  return model;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Neutral history → pi-ai wire messages. Timestamps and assistant-message
 * metadata are stamped here, at call time inside the journaled step (the
 * neutral form is deliberately timestamp-free so assembly stays pure).
 */
export function toPiAiMessages(
  history: readonly PiHistoryMessage[],
  model: Model<Api>,
): Message[] {
  const now = Date.now();
  return history.map((m): Message => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.content.map((b) => ({ ...b })), timestamp: now };
      case "assistant": {
        const content = m.content.map((b) =>
          b.type === "toolCall"
            ? {
                type: "toolCall" as const,
                id: b.toolUseId,
                name: b.name,
                arguments: (b.input ?? {}) as Record<string, unknown>,
              }
            : b.type === "thinking"
              ? {
                  type: "thinking" as const,
                  thinking: b.text,
                  ...(b.signature !== undefined && { thinkingSignature: b.signature }),
                  ...(b.redacted !== undefined && { redacted: b.redacted }),
                }
              : { type: "text" as const, text: b.text },
        );
        return {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
          timestamp: now,
        };
      }
      case "toolResult":
        return {
          role: "toolResult",
          toolCallId: m.toolUseId,
          toolName: m.toolName,
          content: m.content.map((b) => ({ ...b })),
          isError: m.isError,
          timestamp: now,
        };
    }
  });
}

function toPiTurn(msg: AssistantMessage): PiStepTurn {
  const content: PiTurnBlock[] = msg.content.map((b): PiTurnBlock => {
    if (b.type === "toolCall") {
      return {
        type: "toolCall",
        toolUseId: b.id,
        name: b.name,
        input: (b.arguments ?? {}) as JsonValue,
      };
    }
    if (b.type === "thinking") {
      return {
        type: "thinking",
        text: b.thinking,
        ...(b.thinkingSignature !== undefined && { signature: b.thinkingSignature }),
        ...(b.redacted !== undefined && { redacted: b.redacted }),
      };
    }
    return { type: "text", text: b.text };
  });
  const usage: PiTurnUsage = {
    input: msg.usage.input,
    output: msg.usage.output,
    cacheRead: msg.usage.cacheRead,
    cacheWrite: msg.usage.cacheWrite,
    ...(msg.usage.cost.total > 0 && { costUsd: msg.usage.cost.total }),
  };
  const stopReason =
    msg.stopReason === "toolUse" ? "toolUse" : msg.stopReason === "length" ? "length" : "stop";
  return { content, usage, stopReason };
}

class PiAbortError extends Error {
  override readonly name = "AbortError";
}

/** Build the real pi-ai `PiStepClient`. */
export function createPiAiStepClient(opts: PiAiStepClientOptions): PiStepClient {
  const model = resolvePiAiModel({
    model: opts.model,
    ...(opts.provider !== undefined && { provider: opts.provider }),
  });
  const buffered = opts.buffered ?? BUFFERED_PROVIDERS.has(model.provider);
  const streamFn = opts.streamFn ?? streamSimple;
  const completeFn = opts.completeFn ?? completeSimple;
  const contextWindow = typeof model.contextWindow === "number" ? model.contextWindow : undefined;

  return {
    provider: model.provider,
    model: model.id,
    ...(contextWindow !== undefined && { contextWindow }),
    buffered,

    async step(req: PiStepRequest): Promise<PiStepTurn> {
      const context: Context = {
        ...(req.systemPrompt !== undefined && { systemPrompt: req.systemPrompt }),
        messages: toPiAiMessages(req.messages, model),
        ...(req.tools.length > 0 && {
          tools: req.tools.map(
            (t): Tool => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema as never,
            }),
          ),
        }),
      };
      const apiKey =
        typeof opts.apiKey === "function" ? await opts.apiKey(model.provider) : opts.apiKey;
      const streamOptions: SimpleStreamOptions = {
        signal: req.signal,
        timeoutMs: opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
        maxRetries: opts.maxRetries ?? DEFAULT_STEP_MAX_RETRIES,
        ...(apiKey !== undefined && { apiKey }),
        ...(opts.reasoning !== undefined && { reasoning: opts.reasoning }),
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        ...(opts.headers !== undefined && { headers: opts.headers }),
      };

      let finalMessage: AssistantMessage;
      try {
        if (buffered || req.onDelta === undefined) {
          finalMessage = await completeFn(model, context, streamOptions);
        } else {
          const onDelta = req.onDelta;
          const stream = streamFn(model, context, streamOptions);
          for await (const ev of stream) {
            if (ev.type === "text_delta") {
              onDelta({ kind: "text", text: ev.delta });
            } else if (ev.type === "thinking_delta") {
              onDelta({ kind: "reasoning", text: ev.delta });
            } else if (ev.type === "toolcall_delta") {
              const block = ev.partial.content[ev.contentIndex];
              const toolUseId =
                block !== undefined && block.type === "toolCall" ? block.id : undefined;
              onDelta({
                kind: "tool_input",
                ...(toolUseId !== undefined && { toolUseId }),
                text: ev.delta,
              });
            }
          }
          finalMessage = await stream.result();
        }
      } catch (err) {
        if (req.signal.aborted) throw new PiAbortError("LLM step aborted");
        throw toPiProviderError(err, { provider: model.provider, model: model.id });
      }

      // pi-ai's protocol can resolve the final message with an error/abort
      // stopReason instead of rejecting — normalize to the pi-client contract.
      if (finalMessage.stopReason === "aborted") {
        throw new PiAbortError("LLM step aborted");
      }
      if (finalMessage.stopReason === "error") {
        // Classify from the error text (rate-limit/overload phrasing lands in
        // errorMessage on some providers) rather than hardcoding a code.
        throw toPiProviderError(
          new Error(finalMessage.errorMessage ?? "provider returned an error turn"),
          { provider: model.provider, model: model.id },
        );
      }
      return toPiTurn(finalMessage);
    },
  };
}
