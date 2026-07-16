import { describe, expect, it } from "vitest";
import {
  DELTA_FRAMING,
  DELTA_KINDS,
  parseDeltaRecord,
  safeParseDeltaRecord,
  type DeltaKind,
} from "./deltas.js";

const ENTITY = "/t/default/a/researcher/01jz00000000000000000000000";
const TS = "2026-07-17T12:00:00.000Z";

const base = {
  v: 1,
  entityId: ENTITY,
  runId: "run-1",
  ref: "msg-1",
  idx: 0,
  ts: TS,
};

const FIXTURES: Record<DeltaKind, unknown> = {
  text: { ...base, kind: "text", text: "hel" },
  reasoning: { ...base, kind: "reasoning", ref: "rsn-1", text: "hmm" },
  tool_input: { ...base, kind: "tool_input", ref: "toolu_abc", text: '{"cm' },
  usage: {
    ...base,
    kind: "usage",
    ref: "run-1",
    attempt: 2,
    usage: { inputTokens: 10, outputTokens: 5 },
  },
};

describe("delta records (sibling /deltas stream)", () => {
  it("framing decision is the sibling stream", () => {
    expect(DELTA_FRAMING).toBe("sibling-stream");
  });

  it("covers every delta kind with a fixture", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...DELTA_KINDS].sort());
  });

  for (const kind of DELTA_KINDS) {
    it(`parses a valid ${kind} delta`, () => {
      const parsed = parseDeltaRecord(FIXTURES[kind]);
      expect(parsed.kind).toBe(kind);
      expect(parsed.entityId).toBe(ENTITY);
    });
  }

  it("deltas carry NO seq — a seq property is not part of the record", () => {
    const parsed = parseDeltaRecord(FIXTURES.text);
    expect("seq" in parsed).toBe(false);
    // And zod strips one if a confused producer adds it, so it can never
    // leak into the sibling stream's records.
    const withSeq = { ...(FIXTURES.text as object), seq: 5 };
    expect("seq" in parseDeltaRecord(withSeq)).toBe(false);
  });

  it("every delta references its finalized event (ref required)", () => {
    const { ref: _ref, ...noRef } = FIXTURES.text as Record<string, unknown>;
    expect(safeParseDeltaRecord(noRef).success).toBe(false);
  });

  it("idx gaps are legal at the schema level (best-effort ordering)", () => {
    // Chunks 0 and 7 with nothing in between are both valid records —
    // droppedness is normal, not drift (unlike timeline seq).
    expect(safeParseDeltaRecord({ ...base, kind: "text", text: "a" }).success).toBe(true);
    expect(safeParseDeltaRecord({ ...base, kind: "text", text: "b", idx: 7 }).success).toBe(true);
  });

  it("usage deltas accept partial counters", () => {
    const parsed = parseDeltaRecord({
      ...base,
      kind: "usage",
      ref: "run-1",
      usage: { outputTokens: 3 },
    });
    if (parsed.kind === "usage") {
      expect(parsed.usage.outputTokens).toBe(3);
      expect(parsed.usage.inputTokens).toBeUndefined();
    } else {
      expect.unreachable("expected usage delta");
    }
  });

  it("rejects unknown kinds", () => {
    expect(safeParseDeltaRecord({ ...base, kind: "confetti", text: "x" }).success).toBe(false);
  });
});
