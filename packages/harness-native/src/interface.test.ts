import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DeltaInit, TimelineEventInit } from "@teaspill/schema";
import {
  createSafeDeltaEmitter,
  headerSafeIdempotencyKey,
  toolIdempotencyKey,
  type Harness,
  type HarnessRunInput,
  type HarnessRunResult,
  type SteerSource,
  type ToolDefinition,
} from "./interface.js";

const ENTITY = "/t/default/a/researcher/01jz00000000000000000000000";
const TS = "2026-07-17T12:00:00.000Z";

describe("toolIdempotencyKey (exactly-once tool effects)", () => {
  it("is deterministic and injective over its three components", () => {
    const a = toolIdempotencyKey(ENTITY, "run-1", "toolu_a");
    expect(toolIdempotencyKey(ENTITY, "run-1", "toolu_a")).toBe(a);
    // A retried run re-issues the SAME key for the same logical tool call —
    // that identity is the whole exactly-once mechanism.
    expect(a).not.toBe(toolIdempotencyKey(ENTITY, "run-2", "toolu_a"));
    expect(a).not.toBe(toolIdempotencyKey(ENTITY, "run-1", "toolu_b"));
    // No ambiguity from component concatenation: shifting a character across
    // the component boundary yields a different key (the separator is a
    // control char that cannot appear in urls/ids).
    expect(toolIdempotencyKey("/t/d/a/x/y", "run1", "t")).not.toBe(
      toolIdempotencyKey("/t/d/a/x/yr", "un1", "t"),
    );
  });

  it("rejects empty components", () => {
    expect(() => toolIdempotencyKey("", "run-1", "toolu_a")).toThrow();
    expect(() => toolIdempotencyKey(ENTITY, "", "toolu_a")).toThrow();
    expect(() => toolIdempotencyKey(ENTITY, "run-1", "")).toThrow();
  });

  it("rejects components containing the separator", () => {
    expect(() => toolIdempotencyKey(ENTITY, "run\u001f1", "t")).toThrow(/separator/);
  });
});

describe("headerSafeIdempotencyKey (0002:T4.2 - keys must survive HTTP header transport)", () => {
  // undici validates header values at DISPATCH time (not in Headers/Request
  // construction) against the legal field-value charset - HTAB / SP-~ / 0x80-0xFF
  // (RFC 9110 SS5.5; undici lib/core/util headerCharRegex). This regex matches
  // any ILLEGAL char, and U+001F is one - the exact live rejection
  // ("invalid idempotency-key header") this helper exists to prevent.
  const ILLEGAL_HEADER_VALUE_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

  it("the raw key is NOT a legal header value; the encoded key IS", () => {
    const raw = toolIdempotencyKey(ENTITY, "run-1", "toolu_a");
    expect(ILLEGAL_HEADER_VALUE_CHAR.test(raw)).toBe(true); // undici rejects this at fetch time
    const safe = headerSafeIdempotencyKey(raw);
    expect(ILLEGAL_HEADER_VALUE_CHAR.test(safe)).toBe(false);
    // Derived operation keys (the ingress WorkspaceClient appends #w<n>)
    // must survive too.
    expect(ILLEGAL_HEADER_VALUE_CHAR.test(headerSafeIdempotencyKey(raw + "#w3"))).toBe(false);
  });

  it("is injective (encode is bijective), preserving exactly-once identity", () => {
    const a = headerSafeIdempotencyKey(toolIdempotencyKey(ENTITY, "run-1", "toolu_a"));
    const b = headerSafeIdempotencyKey(toolIdempotencyKey(ENTITY, "run-1", "toolu_b"));
    expect(a).not.toBe(b);
    expect(headerSafeIdempotencyKey(toolIdempotencyKey(ENTITY, "run-1", "toolu_a"))).toBe(a);
    expect(decodeURIComponent(a)).toBe(toolIdempotencyKey(ENTITY, "run-1", "toolu_a"));
  });
});

describe("emitDelta invariant: fire-and-forget, never blocks or fails the run", () => {
  const delta: DeltaInit = {
    runId: "run-1",
    ref: "msg-1",
    idx: 0,
    ts: TS,
    kind: "text",
    text: "chunk",
  };

  it("swallows a synchronously throwing sink (streams server down)", () => {
    const emit = createSafeDeltaEmitter(() => {
      throw new Error("ECONNREFUSED: streams server is down");
    });
    expect(() => emit(delta)).not.toThrow();
  });

  it("neutralizes a rejecting async sink (no unhandled rejection)", async () => {
    const drops: unknown[] = [];
    const emit = createSafeDeltaEmitter(() => Promise.reject(new Error("append failed")), {
      onDrop: (err) => drops.push(err),
    });
    expect(() => emit(delta)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(drops).toHaveLength(1);
  });

  it("a throwing onDrop cannot break the invariant either", () => {
    const emit = createSafeDeltaEmitter(
      () => {
        throw new Error("down");
      },
      {
        onDrop: () => {
          throw new Error("metrics also down");
        },
      },
    );
    expect(() => emit(delta)).not.toThrow();
  });

  it("delivers to a healthy sink", () => {
    const sink = vi.fn();
    createSafeDeltaEmitter(sink)(delta);
    expect(sink).toHaveBeenCalledWith(delta);
  });

  it("THE INVARIANT: a run completes and returns its final events even when every delta drops", async () => {
    // A minimal harness that streams deltas for a message and then finalizes
    // it — the shape both real harnesses follow. The delta sink is hard-down.
    const fakeHarness: Harness = {
      kind: "native",
      async run(input: HarnessRunInput): Promise<HarnessRunResult> {
        for (const [idx, chunk] of ["hel", "lo"].entries()) {
          input.emitDelta({
            runId: input.runId,
            ref: "msg-1",
            idx,
            ts: TS,
            kind: "text",
            text: chunk,
          });
        }
        const events: TimelineEventInit[] = [
          {
            ts: TS,
            type: "message",
            payload: {
              id: "msg-1",
              runId: input.runId,
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
            },
          },
        ];
        return {
          events,
          stateDelta: {},
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    };

    let dropCount = 0;
    const steerSource: SteerSource = { drain: async () => [] };
    const result = await fakeHarness.run({
      entityId: ENTITY,
      runId: "run-1",
      canonicalContext: [],
      wakeMessage: { source: "message", content: [{ type: "text", text: "hi" }] },
      tools: [],
      steerSource,
      signal: new AbortController().signal,
      emitDelta: createSafeDeltaEmitter(
        () => {
          throw new Error("streams server unreachable");
        },
        { onDrop: () => dropCount++ },
      ),
    });

    // Deltas dropped…
    expect(dropCount).toBe(2);
    // …but the run proceeded and the final events are ready for the outbox.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe("message");
  });
});

describe("ToolDefinition contract", () => {
  it("a concrete typed tool satisfies the interface and the tools list", () => {
    const echo: ToolDefinition<{ text: string }> = {
      name: "echo",
      description: "Echo the input back.",
      schema: z.object({ text: z.string() }),
      execute: async (input, ctx) => {
        // The ctx carries the bound idempotency key — tool authors never
        // build one themselves.
        expect(ctx.idempotencyKey).toBe(
          toolIdempotencyKey(ctx.entityUrl, ctx.runId, ctx.toolUseId),
        );
        return { content: [{ type: "text", text: input.text }] };
      },
    };

    const input: Pick<HarnessRunInput, "tools"> = { tools: [echo] };
    expect(input.tools[0]!.name).toBe("echo");
  });
});
