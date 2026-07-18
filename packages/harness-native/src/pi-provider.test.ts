/**
 * pi-ai step client (0001:T3.2) — conversion + protocol normalization tests with
 * INJECTED streamFn/completeFn (no network, no real provider).
 */

import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Usage,
  type completeSimple,
  type streamSimple,
} from "@mariozechner/pi-ai";
import { PiProviderError } from "./pi-client.js";
import type { PiHistoryMessage, PiStepDelta } from "./pi-client.js";
import { createPiAiStepClient, toPiAiMessages } from "./pi-provider.js";

const MODEL = {
  id: "fake-model",
  provider: "anthropic",
  api: "anthropic-messages",
  contextWindow: 200_000,
} as unknown as Model<Api>;

const USAGE: Usage = {
  input: 7,
  output: 3,
  cacheRead: 11,
  cacheWrite: 2,
  totalTokens: 23,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

function assistantMessage(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
    ...over,
  };
}

const abortableSignal = (): AbortSignal => new AbortController().signal;

describe("toPiAiMessages", () => {
  it("stamps wire metadata and maps blocks (toolCall ids, thinking signatures, images)", () => {
    const history: PiHistoryMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "YQ==" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "hm", signature: "sig" },
          { type: "toolCall", toolUseId: "tu-1", name: "echo", input: { a: 1 } },
        ],
      },
      { role: "toolResult", toolUseId: "tu-1", toolName: "echo", content: [], isError: false },
    ];
    const wire = toPiAiMessages(history, MODEL);
    expect(wire[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: "YQ==" },
      ],
    });
    expect(wire[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm", thinkingSignature: "sig" },
        { type: "toolCall", id: "tu-1", name: "echo", arguments: { a: 1 } },
      ],
      stopReason: "toolUse", // inferred from the toolCall
      provider: "anthropic",
      model: "fake-model",
    });
    expect(wire[2]).toMatchObject({ role: "toolResult", toolCallId: "tu-1", toolName: "echo" });
  });
});

describe("createPiAiStepClient.step", () => {
  it("streams: forwards deltas (with toolUseId from the partial) and returns the mapped turn", async () => {
    const final = assistantMessage({
      content: [
        { type: "text", text: "hi" },
        { type: "toolCall", id: "tu-1", name: "echo", arguments: { x: 1 } },
      ],
      stopReason: "toolUse",
    });
    const fakeStream = ((_model, _context, _options) => {
      const s = createAssistantMessageEventStream();
      s.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: final });
      s.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"x"', partial: final });
      s.push({ type: "done", reason: "toolUse", message: final });
      return s;
    }) as typeof streamSimple;

    const client = createPiAiStepClient({ model: MODEL, streamFn: fakeStream });
    const deltas: PiStepDelta[] = [];
    const turn = await client.step({
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }],
      signal: abortableSignal(),
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual([
      { kind: "text", text: "hi" },
      { kind: "tool_input", toolUseId: "tu-1", text: '{"x"' },
    ]);
    expect(turn).toEqual({
      content: [
        { type: "text", text: "hi" },
        { type: "toolCall", toolUseId: "tu-1", name: "echo", input: { x: 1 } },
      ],
      usage: { input: 7, output: 3, cacheRead: 11, cacheWrite: 2, costUsd: 0.3 },
      stopReason: "toolUse",
    });
    expect(client.contextWindow).toBe(200_000);
    expect(client.buffered).toBe(false);
  });

  it("buffered: uses completeFn, no deltas, same journal-safe turn", async () => {
    let completeCalls = 0;
    const fakeComplete = (async () => {
      completeCalls += 1;
      return assistantMessage();
    }) as typeof completeSimple;
    const client = createPiAiStepClient({ model: MODEL, buffered: true, completeFn: fakeComplete });
    const turn = await client.step({
      messages: [],
      tools: [],
      signal: abortableSignal(),
      onDelta: () => {
        throw new Error("buffered client must not stream");
      },
    });
    expect(completeCalls).toBe(1);
    expect(turn.content).toEqual([{ type: "text", text: "hello" }]);
    expect(client.buffered).toBe(true);
  });

  it("normalizes a stopReason:'error' final message into a classified PiProviderError", async () => {
    const fakeComplete = (async () =>
      assistantMessage({
        content: [],
        stopReason: "error",
        errorMessage: "429 rate limit exceeded",
      })) as typeof completeSimple;
    const client = createPiAiStepClient({ model: MODEL, buffered: true, completeFn: fakeComplete });
    const err = await client
      .step({ messages: [], tools: [], signal: abortableSignal() })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiProviderError);
    expect((err as PiProviderError).code).toBe("PROVIDER_RATE_LIMITED");
    expect((err as PiProviderError).retryable).toBe(true);
  });

  it("rejects abort-shaped when the signal aborted (never a provider error)", async () => {
    const controller = new AbortController();
    const fakeComplete = (async () => {
      controller.abort();
      throw new Error("fetch aborted");
    }) as typeof completeSimple;
    const client = createPiAiStepClient({ model: MODEL, buffered: true, completeFn: fakeComplete });
    const err = await client
      .step({ messages: [], tools: [], signal: controller.signal })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });

  it("classifies transport throws (network down → retryable PROVIDER_UNREACHABLE)", async () => {
    const fakeComplete = (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as typeof completeSimple;
    const client = createPiAiStepClient({ model: MODEL, buffered: true, completeFn: fakeComplete });
    const err = await client
      .step({ messages: [], tools: [], signal: abortableSignal() })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiProviderError);
    expect((err as PiProviderError).code).toBe("PROVIDER_UNREACHABLE");
    expect((err as PiProviderError).retryable).toBe(true);
  });
});
