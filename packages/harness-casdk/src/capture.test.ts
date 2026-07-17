import { describe, expect, it } from "vitest";
import { CaptureState, type CaptureOptions } from "./capture.js";
import { getTranslation } from "./translation.js";
import { createDetailRecorder } from "./tool-seam.js";
import { collectingDelta, tickingNow } from "./testing.js";
import type { SdkStreamRecord } from "./sdk-client.js";

function makeCapture(overrides: Partial<CaptureOptions> = {}): {
  state: CaptureState;
  deltas: ReturnType<typeof collectingDelta>["deltas"];
} {
  const { deltas, emit } = collectingDelta();
  const state = new CaptureState({
    entityId: "/t/default/a/x/y",
    runId: "run-1",
    attempt: 2,
    table: getTranslation(),
    emitDelta: emit,
    detail: createDetailRecorder(),
    now: tickingNow(),
    ...overrides,
  });
  return { state, deltas };
}

const feed = (state: CaptureState, records: SdkStreamRecord[]): void => {
  for (const r of records) state.onRecord(r);
};

describe("CaptureState (§2 capture direction)", () => {
  it("maps a full tool-loop turn: reasoning → message → tool_call → tool_result → run summary", () => {
    const detail = createDetailRecorder();
    detail.record("toolu_1", { exitCode: 0 });
    const { state } = makeCapture({ detail });
    feed(state, [
      { type: "system", subtype: "init", session_id: "sid-1", model: "m" },
      {
        type: "assistant",
        message: { id: "api-1", content: [{ type: "thinking", thinking: "hm" }], usage: { input_tokens: 5 } },
        parent_tool_use_id: null,
      },
      {
        type: "assistant",
        message: { id: "api-1", content: [{ type: "text", text: "Working. " }], usage: { input_tokens: 5 } },
        parent_tool_use_id: null,
      },
      {
        type: "assistant",
        message: {
          id: "api-1",
          content: [{ type: "tool_use", id: "toolu_1", name: "mcp__teaspill__bash", input: { cmd: "ls" } }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 },
        },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "file.txt" }] }] },
      },
      {
        type: "assistant",
        message: { id: "api-2", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 20, output_tokens: 6 } },
        parent_tool_use_id: null,
      },
      { type: "result", subtype: "success", result: "Done.", total_cost_usd: 0.02, usage: { input_tokens: 999 } },
    ]);
    const res = state.finish();
    expect(res.sessionId).toBe("sid-1");
    expect(res.outcome).toBe("success");
    expect(res.events.map((e) => e.type)).toEqual(["reasoning", "message", "tool_call", "tool_result", "message"]);
    const [rsn, msg, call, result, final] = res.events;
    expect(rsn).toMatchObject({ payload: { id: "rsn-run-1-s0", text: "hm" } });
    expect(msg).toMatchObject({ payload: { id: "msg-run-1-s0", role: "assistant", content: [{ type: "text", text: "Working. " }] } });
    expect(call).toMatchObject({ payload: { toolUseId: "toolu_1", name: "bash", input: { cmd: "ls" } } });
    expect(result).toMatchObject({ payload: { toolUseId: "toolu_1", isError: false, detail: { exitCode: 0 } } });
    expect(final).toMatchObject({ payload: { id: "msg-run-1-s1", content: [{ type: "text", text: "Done." }] } });
    // usage: per-step accumulation (dedup by turn: last block-record wins),
    // result usage NEVER accumulated, cost read from result, attempt stamped.
    expect(res.usage).toMatchObject({
      inputTokens: 32, // turn1 (10 + 2 cache-write, last block-record wins) + turn2 (20)
      outputTokens: 10,
      cacheReadTokens: 3,
      contextTokens: 20,
      steps: 2,
      costUsd: 0.02,
      attempt: 2,
    });
  });

  it("streams deltas with refs matching the finalized event ids; drops signature deltas", () => {
    const { state, deltas } = makeCapture();
    feed(state, [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "He" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "t" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "signature_delta", signature: "sig" } } },
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_9" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"a\":" } } },
      { type: "assistant", message: { id: "api-1", content: [{ type: "text", text: "Hello" }] }, parent_tool_use_id: null },
      { type: "result", subtype: "success" },
    ]);
    const res = state.finish();
    expect(deltas.map((d) => [d.kind, d.ref, d.idx])).toEqual([
      ["text", "msg-run-1-s0", 0],
      ["text", "msg-run-1-s0", 1],
      ["reasoning", "rsn-run-1-s0", 0],
      ["tool_input", "toolu_9", 0],
    ]);
    // finalized message uses the same id the deltas referenced
    expect(res.events[0]).toMatchObject({ type: "message", payload: { id: "msg-run-1-s0" } });
  });

  it("known chatter drops; unknown records become opaque; subagent traffic becomes opaque", () => {
    const { state } = makeCapture();
    feed(state, [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "system", subtype: "status", status: "thinking" },
      { type: "rate_limit_event", rate_limit_info: {} },
      { type: "brand_new_record", subtype: "x", data: 1 },
      { type: "assistant", message: { id: "a", content: [{ type: "text", text: "sub" }] }, parent_tool_use_id: "toolu_parent" },
      { type: "result", subtype: "success" },
    ]);
    const res = state.finish();
    expect(res.events.map((e) => e.type)).toEqual(["opaque", "opaque"]);
    expect(res.events[0]).toMatchObject({ payload: { origin: "casdk", kind: "stream/brand_new_record/x" } });
    expect(res.events[1]).toMatchObject({ payload: { kind: "stream/assistant/subagent" } });
  });

  it("detects a silent fresh-session-on-resume", () => {
    const { state } = makeCapture({ expectedSessionId: "want-this" });
    feed(state, [{ type: "system", subtype: "init", session_id: "got-that" }]);
    expect(state.finish().resumeMismatch).toBe(true);
  });

  it("mirror_error taints the session and records a harness error event", () => {
    const { state } = makeCapture();
    feed(state, [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "system", subtype: "mirror_error", error: "batch dropped" },
    ]);
    const res = state.finish();
    expect(res.sessionTainted).toBe(true);
    expect(res.events[0]).toMatchObject({ type: "error", payload: { code: "casdk_mirror_error", source: "harness" } });
  });

  it("compact_boundary + PostCompact summary → canonical summarization with the run-start fold boundary", () => {
    const { state } = makeCapture({ foldBoundarySeq: 41 });
    feed(state, [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 9000 } },
    ]);
    state.onCompactSummary("Everything so far, condensed.");
    const res = state.finish();
    expect(res.events[0]).toMatchObject({
      type: "summarization",
      payload: {
        summary: "Everything so far, condensed.",
        replacesThroughSeq: 41,
        detail: { trigger: "auto", pre_tokens: 9000 },
      },
    });
  });

  it("a boundary with no summary is preserved as opaque, never silently lost", () => {
    const { state } = makeCapture({ foldBoundarySeq: 41 });
    feed(state, [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1 } },
    ]);
    const res = state.finish();
    expect(res.events[0]).toMatchObject({ type: "opaque", payload: { kind: "stream/system/compact_boundary" } });
  });

  it("error results produce error + outcome error; plain user prompt replays are not captured", () => {
    const { state } = makeCapture();
    feed(state, [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "our own prompt echo" }] } },
      { type: "result", subtype: "error_max_turns", errors: ["too many turns"] },
    ]);
    const res = state.finish();
    expect(res.outcome).toBe("error");
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: "error", payload: { code: "error_max_turns", message: "too many turns" } });
  });
});
