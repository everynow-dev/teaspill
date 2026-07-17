/**
 * Golden fixtures (T7.1, R3): per pinned SDK version,
 * cold-projection → resume(no-op) → capture → canonical must be
 * IDENTITY-MODULO-IDS.
 *
 * Two enforced goldens, checked into `src/__goldens__/<version>/`:
 * 1. `session.jsonl` — the projected transcript for the fixture timeline
 *    (byte-stable via injected uuid/clock). Catches OUR projection drifting.
 * 2. The ROUND TRIP — projecting the fixture, then translating the session
 *    lines back through the capture-side inverse, must equal (modulo ids)
 *    the context-bearing canonical selection. A no-op resume adds nothing to
 *    the transcript (the SDK does not re-stream loaded history — verified
 *    live), so this equality IS the "resume(no-op) → capture" identity; the
 *    env-gated live test (live.test.ts) additionally runs the chain against
 *    the real CLI.
 *
 * Regenerate after a DELIBERATE mapping/SDK change:
 *   UPDATE_GOLDEN=1 pnpm --filter @teaspill/harness-casdk test
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectContextEvents } from "@teaspill/harness-native";
import { normalizeForGolden } from "./golden.js";
import { projectCanonicalToSession, splitTrailingUserEvents } from "./projection.js";
import { parseSessionLines, serializeSessionLines } from "./session-lines.js";
import { PINNED_SDK_VERSION } from "./sdk-client.js";
import { sessionLineToEvents } from "./translation.js";
import { FIXTURE_BASE_MS, fixtureTimeline, seqUuid } from "./testing.js";

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "__goldens__", PINNED_SDK_VERSION);
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

function checkGolden(name: string, actual: string): void {
  const path = join(goldenDir, name);
  if (UPDATE) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  const expected = readFileSync(path, "utf8");
  expect(actual).toBe(expected);
}

describe(`golden fixtures — SDK ${PINNED_SDK_VERSION}`, () => {
  const project = (): ReturnType<typeof projectCanonicalToSession> =>
    projectCanonicalToSession(fixtureTimeline(), { newUuid: seqUuid(), baseTimeMs: FIXTURE_BASE_MS });

  it("cold projection matches the committed session.jsonl byte-for-byte", () => {
    checkGolden("session.jsonl", serializeSessionLines(project().lines));
  });

  it("cold-projection → resume(no-op) → capture → canonical is identity-modulo-ids", () => {
    const timeline = fixtureTimeline();
    const { lines } = project();

    // resume(no-op): the SDK materializes `lines` and streams NOTHING new —
    // the transcript on disk after the no-op IS `lines` (live-verified).
    const roundTripped = parseSessionLines(serializeSessionLines(lines)).flatMap((line) =>
      sessionLineToEvents(line),
    );

    // Reference: the context-bearing canonical selection that was projected
    // (the transcript half of the split; the feed half was never projected).
    const selected = selectContextEvents(timeline, { includeOpaqueOrigins: ["casdk"] });
    const { transcript } = splitTrailingUserEvents(selected);

    expect(normalizeForGolden(roundTripped)).toEqual(normalizeForGolden(transcript));
  });

  it("identity holds across an SDK-version session round-trip with repair present", () => {
    // A dangling tool_call: projection synthesizes the error result, and the
    // round trip reports the REPAIRED conversation (deliberately — that is
    // what the model will actually see on resume).
    const timeline = fixtureTimeline().slice(0, 6); // ends on tool_call toolu_001
    const { lines } = projectCanonicalToSession(timeline, { newUuid: seqUuid(), baseTimeMs: FIXTURE_BASE_MS });
    const back = lines.flatMap((l) => sessionLineToEvents(l));
    const types = back.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result"); // the synthesized repair
  });
});
