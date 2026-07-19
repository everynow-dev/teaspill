/**
 * LIVE CASDK soak (env-gated) — the longer soak beyond live.test.ts's single
 * warm-resume smoke (0002:T4.4 part a). Exercises the warm-resume / interrupt /
 * steer paths that T4.2 wired but could not drive without a live LLM:
 *
 *   1. multi-wake WARM-RESUME CHAIN (3 wakes) with recall across the chain,
 *      plus a session-format DRIFT check against the pinned 0.3.211 goldens
 *      (the real SDK's on-disk session lines must still parse + translate);
 *   2. INTERRUPT MID-TOOL (real in-process MCP tool) → interrupted outcome,
 *      then a clean resume on the next wake;
 *   3. STEER injection drained at a live turn boundary feeding the run.
 *
 * Gated behind TEASPILL_CASDK_LIVE=1 (bundled CLI + real Anthropic auth via
 * ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / subscription keychain). Uses a
 * SMALL model (haiku) deliberately — validating the system on a less-capable
 * model (0002:T4.4 run config). Run:
 *   TEASPILL_CASDK_LIVE=1 pnpm --filter @teaspill/harness-casdk test soak.live
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { finalizeEvent, type TimelineEvent } from "@teaspill/schema";
import type {
  HarnessRunResult,
  PlatformClient,
  SteerMessage,
  ToolContextFactory,
  ToolDefinition,
} from "@teaspill/harness-native";
import { createCasdkHarness, type CasdkHarnessState } from "./harness.js";
import { createClaudeAgentSdkClient } from "./sdk-client.js";
import { createFileSessionStore } from "./session-store.js";
import { loadSdkMcpApi, createMcpToolServer } from "./mcp-server.js";
import { sessionLineToEvents } from "./translation.js";
import { collectingDelta, emptySteerSource, scriptedSteerSource } from "./testing.js";

const LIVE = process.env["TEASPILL_CASDK_LIVE"] === "1";
const MODEL = "claude-haiku-4-5";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const noopPlatform: PlatformClient = {
  spawn: async () => ({ entityId: "/t/default/a/x/child" }),
  send: async () => undefined,
  listChildren: async () => [],
};

function commit(entity: string, context: TimelineEvent[], result: HarnessRunResult): TimelineEvent[] {
  let seq = context.length > 0 ? context[context.length - 1]!.seq + 1 : 0;
  return [
    ...context,
    ...result.events.map((init) => finalizeEvent(init, { entityId: entity, seq: seq++ })),
  ];
}

const spawned = (entity: string): TimelineEvent =>
  finalizeEvent(
    { type: "entity_spawned", ts: new Date().toISOString(), payload: { entityType: "soak", parentId: null } },
    { entityId: entity, seq: 0 },
  );

const wake = (entity: string, seq: number, text: string): TimelineEvent =>
  finalizeEvent(
    {
      type: "message",
      ts: new Date().toISOString(),
      payload: { id: `wake-${String(seq)}`, role: "user", content: [{ type: "text", text }] },
    },
    { entityId: entity, seq },
  );

const assistantText = (r: HarnessRunResult): string =>
  r.events
    .filter((e) => e.type === "message")
    .flatMap((e) => (e.payload as { role: string; content: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? "")
    .join(" ");

describe.skipIf(!LIVE)("live CASDK soak (real subprocess)", () => {
  const dir = mkdtempSync(join(tmpdir(), "teaspill-casdk-soak-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("3-wake warm-resume chain recalls across the chain; no 0.3.211 session drift", { timeout: 300_000 }, async () => {
    const ENTITY = "/t/default/a/soak/chain";
    const store = createFileSessionStore(dir);
    const sdk = createClaudeAgentSdkClient();
    const harness = createCasdkHarness({
      store,
      sdk,
      model: MODEL,
      systemPrompt: "You are a terse test agent. Follow instructions exactly.",
      maxTurns: 3,
    });
    const runWake = async (context: TimelineEvent[], n: number): Promise<HarnessRunResult> =>
      harness.run({
        entityId: ENTITY,
        runId: `chain-${String(n)}`,
        canonicalContext: context,
        wakeMessage: null,
        tools: [],
        steerSource: emptySteerSource(),
        signal: new AbortController().signal,
        emitDelta: collectingDelta().emit,
      });

    // wake 1 (cold/fresh)
    let context: TimelineEvent[] = [spawned(ENTITY), wake(ENTITY, 1, "Remember token ALPHA-111. Reply with exactly: OK")];
    const r1 = await runWake(context, 1);
    expect(r1.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "success" } });
    const s1 = r1.stateDelta.harness as unknown as CasdkHarnessState;
    expect(s1.mode).toBe("cold");
    context = commit(ENTITY, context, r1);

    // wake 2 (WARM)
    context = [...context, wake(ENTITY, context.length, "Also remember token BETA-222. Reply with exactly: OK")];
    const r2 = await runWake(context, 2);
    const s2 = r2.stateDelta.harness as unknown as CasdkHarnessState;
    expect(s2.mode).toBe("warm");
    expect(s2.sessionId).toBe(s1.sessionId);
    context = commit(ENTITY, context, r2);

    // wake 3 (WARM) — recall BOTH tokens across the chain
    context = [...context, wake(ENTITY, context.length, "List the two tokens I told you to remember, comma-separated.")];
    const r3 = await runWake(context, 3);
    const s3 = r3.stateDelta.harness as unknown as CasdkHarnessState;
    expect(s3.mode).toBe("warm");
    expect(s3.sessionId).toBe(s1.sessionId);
    const recall = assistantText(r3);
    expect(recall).toContain("ALPHA-111");
    expect(recall).toContain("BETA-222");
    expect(r3.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "success" } });

    // --- session-format DRIFT check against pinned 0.3.211 ------------------
    // The REAL SDK's on-disk session lines must still parse and translate
    // through our (0.3.211-pinned) translation table with no unknown shapes.
    const meta = await store.loadMeta(ENTITY);
    expect(meta).not.toBeNull();
    const lines = await store.loadLines(ENTITY, meta!.sessionId);
    expect(lines).not.toBeNull();
    expect(lines!.length).toBeGreaterThan(0);
    let translated = 0;
    for (const line of lines!) translated += sessionLineToEvents(line).length; // throws on drift
    expect(translated).toBeGreaterThan(0);
    expect(lines!.some((l) => l.type === "user")).toBe(true);
    expect(lines!.some((l) => l.type === "assistant")).toBe(true);
  });

  it("interrupt MID-TOOL yields an interrupted outcome, then resumes on the next wake", { timeout: 300_000 }, async () => {
    const ENTITY = "/t/default/a/soak/interrupt";
    const store = createFileSessionStore(dir);
    const sdk = createClaudeAgentSdkClient();
    const api = await loadSdkMcpApi();

    let toolStarted = false;
    let toolSawAbort = false;
    const longTool: ToolDefinition<{ seconds: number }> = {
      name: "long_task",
      description: "Run a long background task for the given number of seconds.",
      schema: z.object({ seconds: z.number() }).strict(),
      async execute(input, ctx) {
        toolStarted = true;
        await new Promise<void>((res) => {
          if (ctx.signal.aborted) {
            toolSawAbort = true;
            return res();
          }
          const timer = setTimeout(res, input.seconds * 1000);
          ctx.signal.addEventListener(
            "abort",
            () => {
              toolSawAbort = true;
              clearTimeout(timer);
              res();
            },
            { once: true },
          );
        });
        return { content: [{ type: "text", text: "long task done" }] };
      },
    };

    const toolContext: ToolContextFactory = (b) => ({
      entityUrl: b.entityUrl,
      runId: b.runId,
      toolUseId: b.toolUseId,
      idempotencyKey: b.idempotencyKey,
      signal: b.signal,
      platform: noopPlatform,
    });

    const harness = createCasdkHarness({
      store,
      sdk,
      model: MODEL,
      systemPrompt:
        "You have a long_task tool. When asked to run it, call long_task with the requested seconds. " +
        "Do not answer without calling the tool.",
      maxTurns: 4,
      toolServer: createMcpToolServer(api),
      toolContext,
    });

    const ac = new AbortController();
    let context: TimelineEvent[] = [spawned(ENTITY), wake(ENTITY, 1, "Run the long_task tool with seconds=45.")];
    const runP = harness.run({
      entityId: ENTITY,
      runId: "interrupt-1",
      canonicalContext: context,
      wakeMessage: null,
      tools: [longTool as unknown as ToolDefinition<never>],
      steerSource: emptySteerSource(),
      signal: ac.signal,
      emitDelta: collectingDelta().emit,
    });

    const started = Date.now();
    while (!toolStarted && Date.now() - started < 150_000) await sleep(200);
    expect(toolStarted).toBe(true); // the tool actually began before we interrupt
    ac.abort();
    const r1 = await runP;
    expect(r1.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "interrupted" } });
    expect(toolSawAbort).toBe(true); // the abort reached the running tool

    // resume: a fresh (non-aborted) wake completes cleanly.
    context = commit(ENTITY, context, r1);
    context = [...context, wake(ENTITY, context.length, "Never mind the task. Reply with exactly: RESUMED")];
    const r2 = await harness.run({
      entityId: ENTITY,
      runId: "interrupt-2",
      canonicalContext: context,
      wakeMessage: null,
      tools: [longTool as unknown as ToolDefinition<never>],
      steerSource: emptySteerSource(),
      signal: new AbortController().signal,
      emitDelta: collectingDelta().emit,
    });
    expect(r2.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "success" } });
    expect(assistantText(r2)).toContain("RESUMED");
  });

  it("a steer drained at the turn boundary feeds the live run", { timeout: 300_000 }, async () => {
    const ENTITY = "/t/default/a/soak/steer";
    const store = createFileSessionStore(dir);
    const sdk = createClaudeAgentSdkClient();
    const harness = createCasdkHarness({
      store,
      sdk,
      model: MODEL,
      systemPrompt: "You are a terse test agent. Follow each instruction exactly.",
      maxTurns: 4,
    });
    const steerMsg: SteerMessage = {
      id: "steer-1",
      ts: new Date().toISOString(),
      content: [{ type: "text", text: "Now also reply with exactly this word on its own line: STEERED" }],
    };
    const steer = scriptedSteerSource([[steerMsg]]);
    const context: TimelineEvent[] = [spawned(ENTITY), wake(ENTITY, 1, "Reply with exactly: FIRST")];
    const r = await harness.run({
      entityId: ENTITY,
      runId: "steer-1",
      canonicalContext: context,
      wakeMessage: null,
      tools: [],
      steerSource: steer,
      signal: new AbortController().signal,
      emitDelta: collectingDelta().emit,
    });

    expect(steer.drains).toBeGreaterThanOrEqual(1); // the steerbox was drained at the boundary
    // the steered user message was interleaved into canonical…
    const userTexts = r.events
      .filter((e) => e.type === "message" && (e.payload as { role: string }).role === "user")
      .flatMap((e) => (e.payload as { content: Array<{ text?: string }> }).content)
      .map((b) => b.text ?? "")
      .join(" ");
    expect(userTexts).toContain("STEERED");
    // …and the model acted on it in a follow-up turn.
    expect(assistantText(r)).toContain("STEERED");
    expect(r.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "success" } });
  });
});
