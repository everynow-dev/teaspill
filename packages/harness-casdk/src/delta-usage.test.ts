/**
 * 0001:T7.4 — the delta + usage mapping, tested in isolation from the run loop.
 *
 * Three concerns, each traced to docs/casdk-mapping.md:
 * 1. §6 usage field mapping — canned SdkUsage → canonical RunUsage, field by
 *    field, including the last-step contextTokens rule and the cost/attempt
 *    stamping.
 * 2. §2 partial-event classification — every stream_event delta kind + the
 *    signature drop + the ignore cases.
 * 3. attempt reconciliation — a retried run (attempt N then N+1) produces both
 *    usage figures each carrying their attempt, in exactly the shape the 0001:T5.2
 *    reducer's latest-attempt-wins supersede consumes.
 */

import { describe, expect, it } from "vitest";
import { safeParseDeltaRecord } from "@teaspill/schema";
import {
  UsageAccumulator,
  accumulateStepUsage,
  buildUsageDelta,
  classifyPartial,
  emptyUsageTotals,
  finalizeUsage,
  usageSnapshot,
} from "./delta-usage.js";
import { CaptureState } from "./capture.js";
import { getTranslation } from "./translation.js";
import { createDetailRecorder } from "./tool-seam.js";
import { collectingDelta, tickingNow } from "./testing.js";
import type { SdkStreamRecord, SdkUsage } from "./sdk-client.js";

// ===========================================================================
// §6 — usage field mapping
// ===========================================================================

describe("usage field mapping (docs/casdk-mapping.md §6)", () => {
  it("maps one Anthropic/CASDK usage record field-by-field", () => {
    const u: SdkUsage = {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 300,
      output_tokens: 40,
    };
    const totals = accumulateStepUsage(emptyUsageTotals(), u);
    const usage = finalizeUsage(totals, { costUsd: 0.5, attempt: 3 });
    expect(usage).toEqual({
      inputTokens: 120, // input_tokens + cache_creation_input_tokens
      cacheReadTokens: 300, // cache_read_input_tokens
      outputTokens: 40, // output_tokens
      contextTokens: 420, // input + cache_creation + cache_read (last step)
      steps: 1,
      costUsd: 0.5,
      attempt: 3,
    });
  });

  it("omits cacheReadTokens when zero and contextTokens when no step had usage", () => {
    // A step with no usage record still counts toward `steps`.
    const totals = accumulateStepUsage(emptyUsageTotals(), undefined);
    expect(finalizeUsage(totals)).toEqual({ inputTokens: 0, outputTokens: 0, steps: 1 });
  });

  it("sums input/cacheRead/output across steps but contextTokens tracks the LAST step only", () => {
    let t = emptyUsageTotals();
    t = accumulateStepUsage(t, { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 4 });
    t = accumulateStepUsage(t, { input_tokens: 20, cache_read_input_tokens: 7, output_tokens: 6 });
    expect(finalizeUsage(t, { attempt: 0 })).toEqual({
      inputTokens: 32, // (10+2) + (20+0)
      cacheReadTokens: 12, // 5 + 7
      outputTokens: 10, // 4 + 6
      contextTokens: 27, // last step: 20 + 0 + 7
      steps: 2,
      attempt: 0,
    });
  });

  it("cumulative snapshot (live gauge) carries no cost and no attempt", () => {
    let t = emptyUsageTotals();
    t = accumulateStepUsage(t, { input_tokens: 8, output_tokens: 3 });
    expect(usageSnapshot(t)).toEqual({ inputTokens: 8, outputTokens: 3, steps: 1, contextTokens: 8 });
  });

  it("UsageAccumulator mirrors the pure folds and exposes contextTokens", () => {
    const acc = new UsageAccumulator();
    acc.addStep({ input_tokens: 5, cache_read_input_tokens: 1, output_tokens: 2 });
    acc.addStep(undefined);
    expect(acc.steps).toBe(2);
    expect(acc.contextTokens).toBe(6);
    expect(acc.finalize({ attempt: 1 })).toEqual({
      inputTokens: 5,
      cacheReadTokens: 1,
      outputTokens: 2,
      contextTokens: 6,
      steps: 2,
      attempt: 1,
    });
  });
});

// ===========================================================================
// §2 — partial stream_event → delta classification
// ===========================================================================

describe("partial-event classification (docs/casdk-mapping.md §2)", () => {
  it("classifies each delta kind, the tool-block start, and the signature drop", () => {
    expect(classifyPartial({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })).toEqual({
      op: "text",
      text: "hi",
    });
    expect(classifyPartial({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } })).toEqual({
      op: "reasoning",
      text: "hmm",
    });
    expect(classifyPartial({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"a":' } })).toEqual({
      op: "tool_input",
      text: '{"a":',
    });
    expect(classifyPartial({ type: "content_block_delta", delta: { type: "signature_delta", signature: "sig" } })).toEqual({
      op: "signature_drop",
    });
    expect(
      classifyPartial({ type: "content_block_start", content_block: { type: "tool_use", id: "toolu_7" } }),
    ).toEqual({ op: "tool_block_start", toolUseId: "toolu_7" });
    // A non-tool content_block_start carries no toolUseId.
    expect(classifyPartial({ type: "content_block_start", content_block: { type: "text" } })).toEqual({
      op: "tool_block_start",
      toolUseId: undefined,
    });
  });

  it("ignores message lifecycle events and malformed/empty events", () => {
    expect(classifyPartial({ type: "message_start" }).op).toBe("ignore");
    expect(classifyPartial({ type: "message_delta", delta: { type: "unknown" } }).op).toBe("ignore");
    expect(classifyPartial({ type: "content_block_delta" }).op).toBe("ignore");
    expect(classifyPartial(undefined).op).toBe("ignore");
  });
});

// ===========================================================================
// live usage delta — shape + schema validity
// ===========================================================================

describe("live usage DeltaRecord", () => {
  it("has ref=runId, carries attempt, and is a valid usage DeltaRecord", () => {
    const init = buildUsageDelta({
      runId: "run-x",
      idx: 2,
      ts: new Date(0).toISOString(),
      usage: { inputTokens: 10, outputTokens: 4, steps: 1 },
      attempt: 5,
    });
    expect(init).toMatchObject({ kind: "usage", runId: "run-x", ref: "run-x", idx: 2, attempt: 5 });
    // The sink stamps v + entityId; the full record must then parse.
    const parsed = safeParseDeltaRecord({ ...init, v: 1, entityId: "/t/default/a/x/y" });
    expect(parsed.success).toBe(true);
  });

  it("omits attempt when the run has none", () => {
    const init = buildUsageDelta({ runId: "r", idx: 0, ts: new Date(0).toISOString(), usage: {} });
    expect("attempt" in init).toBe(false);
  });
});

// ===========================================================================
// end-to-end through CaptureState — deltas + usage + attempt
// ===========================================================================

function makeCapture(attempt: number | undefined): {
  state: CaptureState;
  deltas: ReturnType<typeof collectingDelta>["deltas"];
} {
  const { deltas, emit } = collectingDelta();
  const state = new CaptureState({
    entityId: "/t/default/a/x/y",
    runId: "run-1",
    attempt,
    table: getTranslation(),
    emitDelta: emit,
    detail: createDetailRecorder(),
    now: tickingNow(),
  });
  return { state, deltas };
}

const feed = (state: CaptureState, records: SdkStreamRecord[]): void => {
  for (const r of records) state.onRecord(r);
};

/** A one-step assistant turn with text deltas + step usage + a terminal result. */
function oneStepRun(): SdkStreamRecord[] {
  return [
    { type: "system", subtype: "init", session_id: "s" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
    {
      type: "assistant",
      message: { id: "api-1", content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 12, output_tokens: 3 } },
      parent_tool_use_id: null,
    },
    { type: "result", subtype: "success", total_cost_usd: 0.02, usage: { input_tokens: 999 } },
  ] as SdkStreamRecord[];
}

describe("CaptureState — live usage delta alongside token deltas", () => {
  it("emits a usage gauge delta (ref=runId) once the usage-bearing step flushes", () => {
    const { state, deltas } = makeCapture(0);
    feed(state, oneStepRun());
    state.finish();

    const textDeltas = deltas.filter((d) => d.kind === "text");
    expect(textDeltas.map((d) => (d as { text: string }).text)).toEqual(["Hel", "lo"]);

    const usageDeltas = deltas.filter((d) => d.kind === "usage");
    expect(usageDeltas).toHaveLength(1);
    expect(usageDeltas[0]).toMatchObject({
      kind: "usage",
      ref: "run-1", // ref = runId (deltas.ts contract)
      runId: "run-1",
      attempt: 0,
      usage: { inputTokens: 12, outputTokens: 3, steps: 1, contextTokens: 12 },
    });
  });
});

// ===========================================================================
// attempt reconciliation — the load-bearing bit (0001:T7.4)
// ===========================================================================

describe("attempt reconciliation across a Restate retry", () => {
  it("failed attempt N then retried attempt N+1: each usage figure carries its own attempt", () => {
    // attempt 0 (the failed run) and attempt 1 (the retry) of the SAME runId.
    const a0 = makeCapture(0);
    feed(a0.state, oneStepRun());
    const r0 = a0.state.finish();

    const a1 = makeCapture(1);
    feed(a1.state, oneStepRun());
    const r1 = a1.state.finish();

    // run_finished usage: same tokens, distinct attempt.
    expect(r0.usage.attempt).toBe(0);
    expect(r1.usage.attempt).toBe(1);
    expect(r0.usage.inputTokens).toBe(r1.usage.inputTokens);

    // live usage deltas carry their attempt too.
    expect(a0.deltas.find((d) => d.kind === "usage")).toMatchObject({ attempt: 0 });
    expect(a1.deltas.find((d) => d.kind === "usage")).toMatchObject({ attempt: 1 });
  });

  it("produces exactly the shape the 0001:T5.2 reducer's latest-attempt-wins consumes", () => {
    // The reducer keys liveUsage by ref (=runId) and keeps the record whose
    // `attempt` is highest; a lower-attempt straggler is dropped. Here we
    // assert our emitted records expose (ref, runId, attempt, usage) so that
    // supersede is decidable, and that the higher attempt is a full valid
    // record (no reliance on merge with the stale one).
    const a1 = makeCapture(1);
    feed(a1.state, oneStepRun());
    a1.state.finish();

    const latest = a1.deltas.find((d) => d.kind === "usage")!;
    expect(latest.ref).toBe(latest.runId); // reducer buckets by ref==runId
    expect(latest.attempt).toBe(1);
    // The full record (post sink-stamp) is a valid usage DeltaRecord.
    const parsed = safeParseDeltaRecord({ ...latest, v: 1, entityId: "/t/default/a/x/y" });
    expect(parsed.success).toBe(true);

    // A stale attempt-0 record for the same ref is strictly lower — the
    // reducer's `attempt < cur.attempt` guard drops it.
    const a0 = makeCapture(0);
    feed(a0.state, oneStepRun());
    a0.state.finish();
    const stale = a0.deltas.find((d) => d.kind === "usage")!;
    expect(stale.ref).toBe(latest.ref);
    expect((stale.attempt ?? 0) < (latest.attempt ?? 0)).toBe(true);
  });
});
