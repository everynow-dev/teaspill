/**
 * LIVE smoke test (env-gated) — the real `@anthropic-ai/claude-agent-sdk`
 * subprocess against the real harness, exercising the warm path end-to-end:
 *
 *   wake 1 (cold/fresh) → capture → simulate the handler's outbox commit →
 *   wake 2 (WARM resume by seq stamp) → the model recalls wake-1 content.
 *
 * Gated behind TEASPILL_CASDK_LIVE=1 because it needs the bundled CLI plus
 * real Anthropic auth (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN /
 * subscription keychain). Run:
 *   TEASPILL_CASDK_LIVE=1 pnpm --filter @teaspill/harness-casdk test
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { finalizeEvent, type TimelineEvent } from "@teaspill/schema";
import type { HarnessRunResult } from "@teaspill/harness-native";
import { createCasdkHarness, type CasdkHarnessState } from "./harness.js";
import { createClaudeAgentSdkClient } from "./sdk-client.js";
import { createFileSessionStore } from "./session-store.js";
import { collectingDelta, emptySteerSource } from "./testing.js";

const LIVE = process.env["TEASPILL_CASDK_LIVE"] === "1";
const ENTITY = "/t/default/a/live-smoke/s1";

/** Simulate the agent handler's outbox: allocate seqs onto the returned events. */
function commit(context: TimelineEvent[], result: HarnessRunResult): TimelineEvent[] {
  let seq = context.length > 0 ? context[context.length - 1]!.seq + 1 : 0;
  return [
    ...context,
    ...result.events.map((init) => finalizeEvent(init, { entityId: ENTITY, seq: seq++ })),
  ];
}

const wake = (seq: number, text: string): TimelineEvent =>
  finalizeEvent(
    { type: "message", ts: new Date().toISOString(), payload: { id: `wake-${String(seq)}`, role: "user", content: [{ type: "text", text }] } },
    { entityId: ENTITY, seq },
  );

describe.skipIf(!LIVE)("live CASDK smoke (real subprocess)", () => {
  const dir = mkdtempSync(join(tmpdir(), "teaspill-casdk-live-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("cold first wake then WARM resume with recall across processes", { timeout: 300_000 }, async () => {
    const store = createFileSessionStore(dir);
    const sdk = createClaudeAgentSdkClient();
    const harness = createCasdkHarness({
      store,
      sdk,
      model: "claude-haiku-4-5",
      systemPrompt: "You are a terse test agent.",
      maxTurns: 4,
    });

    // --- wake 1 (fresh entity → cold/fresh session) -----------------------
    let context: TimelineEvent[] = [
      finalizeEvent(
        { type: "entity_spawned", ts: new Date().toISOString(), payload: { entityType: "live-smoke", parentId: null } },
        { entityId: ENTITY, seq: 0 },
      ),
      wake(1, "Remember this token: ZEBRA-9182. Reply with exactly: OK"),
    ];
    const d1 = collectingDelta();
    const r1 = await harness.run({
      entityId: ENTITY,
      runId: "live-run-1",
      canonicalContext: context,
      wakeMessage: null,
      tools: [],
      steerSource: emptySteerSource(),
      signal: new AbortController().signal,
      emitDelta: d1.emit,
    });
    expect(r1.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "success" } });
    const s1 = r1.stateDelta.harness as unknown as CasdkHarnessState;
    expect(s1.sessionId).toBeTruthy();

    // handler commit → canonical head now equals the saved stamp
    context = commit(context, r1);
    expect(context[context.length - 1]!.seq).toBe(s1.seqStamp);

    // --- wake 2 (stamp == head - 1 after new wake commits → WARM) ---------
    context = [...context, wake(context.length, "What token did I ask you to remember? Reply with the token only.")];
    const d2 = collectingDelta();
    const r2 = await harness.run({
      entityId: ENTITY,
      runId: "live-run-2",
      canonicalContext: context,
      wakeMessage: null,
      tools: [],
      steerSource: emptySteerSource(),
      signal: new AbortController().signal,
      emitDelta: d2.emit,
    });
    const s2 = r2.stateDelta.harness as unknown as CasdkHarnessState;
    expect(s2.mode).toBe("warm"); // resumed, NOT re-projected
    expect(s2.sessionId).toBe(s1.sessionId); // the same durable session
    const texts = r2.events
      .filter((e) => e.type === "message")
      .flatMap((e) => (e.payload as { content: Array<{ type: string; text?: string }> }).content)
      .map((b) => b.text ?? "")
      .join(" ");
    expect(texts).toContain("ZEBRA-9182"); // recall through the warm resume
    expect(r2.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "success" } });
  });
});
