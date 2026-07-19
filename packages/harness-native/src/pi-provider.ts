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
 * ## Streaming vs buffered (0001:T3.2 "Anticipate"; 0002:T4.4 graceful impl)
 *
 * Default is STREAMED for every provider (`streamSimple`), forwarding
 * text/thinking/tool-input fragments to the harness's delta channel. The
 * journal granularity is IDENTICAL to buffered either way — the journaled unit
 * is the completed turn, and the streamed and buffered final results are the
 * same object — so buffering only silences the ephemeral delta channel.
 *
 * There is NO static provider allowlist (a hardcoded set would drift as
 * providers/models change). Instead `step()` handles streamed-vs-buffered
 * gracefully per call:
 *
 * - **Auto-fallback:** if a streamed call throws a NON-abort error (transport
 *   or parse glitch), `step()` transparently re-runs THIS SAME turn via
 *   `completeFn` and returns its result — safe because the two finals are
 *   identical. An abort mid-stream is NOT recovered (it propagates as a
 *   `PiAbortError`); and if the buffered fallback ALSO throws, THAT error
 *   surfaces (a real provider error — e.g. Gemini's 400 schema-too-complex —
 *   reproduces under buffered and is correctly not masked).
 * - **Sticky (runtime-learned):** once a fallback fires, a per-client-instance
 *   flag routes later `step()` calls straight to `completeFn`, so a flaky
 *   provider is not re-probed with a wasted failed-stream attempt each turn.
 *   It resets with the client instance (per process/wake) — never drifts.
 * - **Explicit `opts.buffered: true`** forces buffered from the first call.
 *   This is the ONLY remaining reason to force buffering: the rare provider
 *   whose streamed final SILENTLY diverges from buffered WITHOUT throwing
 *   (undetectable at runtime). It is a DEPLOYMENT CONFIG choice, not a
 *   library-maintained list.
 *
 * 0002:T4.4 soak evidence that this is a pure improvement: both non-Anthropic
 * providers exercised (`google`, `opencode-go`) stream cleanly; google's real
 * failures are a recursive tool schema + a missing thought_signature (schema/
 * protocol, reproduce under buffered too) — never a streaming-reliability
 * issue that an allowlist would have helped.
 *
 * Determinism: all of this lives inside the harness's journaled `ctx.run` step
 * (`step()` is not re-executed on replay), so the fallback + sticky flag are
 * replay-safe.
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
  type PiStepDelta,
  type PiStepRequest,
  type PiStepTurn,
  type PiTurnBlock,
  type PiTurnUsage,
} from "./pi-client.js";

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
  // Force buffered ONLY on explicit deployment opt-in (the silent-divergence
  // case); otherwise stream by default and recover per call (see module doc).
  const forceBuffered = opts.buffered ?? false;
  const streamFn = opts.streamFn ?? streamSimple;
  const completeFn = opts.completeFn ?? completeSimple;
  const contextWindow = typeof model.contextWindow === "number" ? model.contextWindow : undefined;
  // Runtime-learned (per client instance): set once a streamed call falls back
  // to buffered, so later steps skip the wasted failed-stream attempt. Resets
  // with the client (per process/wake) — can never drift like a static list.
  let streamFellBack = false;

  return {
    provider: model.provider,
    model: model.id,
    ...(contextWindow !== undefined && { contextWindow }),
    buffered: forceBuffered,

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

      const runBuffered = (): Promise<AssistantMessage> =>
        completeFn(model, context, streamOptions);
      const runStreamed = async (
        onDelta: (d: PiStepDelta) => void,
      ): Promise<AssistantMessage> => {
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
        return stream.result();
      };

      let finalMessage: AssistantMessage;
      try {
        if (forceBuffered || streamFellBack || req.onDelta === undefined) {
          finalMessage = await runBuffered();
        } else {
          try {
            finalMessage = await runStreamed(req.onDelta);
          } catch {
            // Abort mid-stream is a normal outcome — never recover it.
            if (req.signal.aborted) throw new PiAbortError("LLM step aborted");
            // Catchable stream glitch: the journaled unit is the whole turn and
            // the buffered final is identical, so recover THIS turn via the
            // buffered path and stick to it for later steps on this client. A
            // throw from the fallback bubbles to the outer catch (a real
            // provider error — correctly surfaced, not masked).
            streamFellBack = true;
            finalMessage = await runBuffered();
          }
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
