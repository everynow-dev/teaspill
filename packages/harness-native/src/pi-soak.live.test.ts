/**
 * LIVE pi-ai provider soak + model-ergonomics tuning harness (0002:T4.4).
 *
 * Drives the REAL `createPiHarness` loop over the REAL non-Anthropic providers
 * (`google`, `opencode-go`) with the REAL platform tools, to:
 *   (b) validate that streaming (`streamSimple`) yields a clean per-call step
 *       boundary for these providers — the evidence behind the graceful
 *       stream→buffered fallback in `createPiAiStepClient.step()` (no static
 *       allowlist). A provider passes streaming if the harness loop completes
 *       with correct tool calls and streaming deltas actually arrive.
 *   (c) surface how SMALL models MISUSE the async spawn/wake model, so the
 *       tool descriptions can be tuned. Small models are the point — their
 *       misuses are the signal.
 *
 * Gated per provider on its key so the default offline suite stays green:
 *   GEMINI_API_KEY=... OPENCODE_API_KEY=... \
 *     pnpm --filter @teaspill/harness-native test pi-soak.live
 *
 * Transcripts are written to work/plans/0002-follow-ups/notes/ as the tuning
 * evidence trail (only when the run actually executes).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { finalizeEvent } from "@teaspill/schema";
import type { DeltaInit, TimelineEvent, TimelineEventInit } from "@teaspill/schema";
import type {
  HarnessRunInput,
  PlatformClient,
  SpawnRequest,
  SendRequest,
  ToolContext,
} from "./interface.js";
import { createPiHarness, type HarnessCtx } from "./pi-harness.js";
import { platformTools } from "./tools.js";
import { createPiAiStepClient } from "./pi-provider.js";

const GEMINI = process.env["GEMINI_API_KEY"];
const OPENCODE = process.env["OPENCODE_API_KEY"];

const NOTES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../work/plans/0002-follow-ups/notes",
);

// ---------------------------------------------------------------------------
// In-memory doubles (the harness is pure over its injected seams).
// ---------------------------------------------------------------------------

/** Restate `ctx.run` seam: run each closure once, no replay in a live soak. */
class MemCtx implements HarnessCtx {
  async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
    return action();
  }
}

/** Records every platform effect the model drives. */
class RecordingPlatform implements PlatformClient {
  readonly spawns: SpawnRequest[] = [];
  readonly sends: SendRequest[] = [];
  listChildrenCalls = 0;
  async spawn(req: SpawnRequest): Promise<{ entityId: string }> {
    this.spawns.push(req);
    const id = req.id ?? `01child${String(this.spawns.length).padStart(3, "0")}`;
    return { entityId: `/t/default/a/${req.entityType}/${id}` };
  }
  async send(req: SendRequest): Promise<void> {
    this.sends.push(req);
  }
  async listChildren(): Promise<Array<{ entityId: string; entityType: string; status: string }>> {
    this.listChildrenCalls++;
    // Deliberately empty: a just-spawned child has no RESULT yet (it arrives
    // later as child_finished). A model that expects a result here is misusing
    // the async model.
    return [];
  }
}

const ENTITY = "/t/default/a/orchestrator/01soakorchestrator00000000";

function canonicalWith(wakeText: string): TimelineEvent[] {
  const inits: TimelineEventInit[] = [
    {
      type: "entity_spawned",
      ts: "2026-07-19T00:00:00.000Z",
      payload: { entityType: "orchestrator", parentId: null },
    },
    {
      type: "message",
      ts: "2026-07-19T00:00:01.000Z",
      payload: { id: "wake-0", role: "user", content: [{ type: "text", text: wakeText }] },
    },
  ];
  return inits.map((init, seq) => finalizeEvent(init, { entityId: ENTITY, seq }));
}

interface SoakOutcome {
  provider: string;
  model: string;
  toolSequence: string[];
  spawns: SpawnRequest[];
  sends: SendRequest[];
  listChildrenCalls: number;
  assistantText: string[];
  deltaKinds: Record<string, number>;
  llmSteps: number;
  outcome: string;
  events: Array<{ type: string; payload: unknown }>;
}

async function runScenario(args: {
  provider: "google" | "opencode-go";
  model: string;
  apiKey: string;
  wakeText: string;
  systemPrompt: string;
  label: string;
}): Promise<SoakOutcome> {
  const platform = new RecordingPlatform();
  const deltas: DeltaInit[] = [];
  const committed: TimelineEventInit[] = [];

  const client = createPiAiStepClient({
    model: args.model,
    provider: args.provider,
    apiKey: args.apiKey,
    maxTokens: 512,
    maxRetries: 1,
    timeoutMs: 60_000,
  });

  const input: HarnessRunInput = {
    entityId: ENTITY,
    runId: `soak-${args.label}`,
    attempt: 1,
    canonicalContext: canonicalWith(args.wakeText),
    wakeMessage: null,
    tools: platformTools() as never,
    steerSource: { drain: async () => [] },
    signal: new AbortController().signal,
    emitDelta: (d) => deltas.push(d),
    commitEvents: async (evts): Promise<readonly TimelineEvent[]> => {
      committed.push(...evts);
      return evts.map((init, i) =>
        finalizeEvent(init, { entityId: ENTITY, seq: 100 + committed.length + i }),
      );
    },
  };

  const platformFactory = (b: {
    entityUrl: string;
    runId: string;
    toolUseId: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): ToolContext => ({
    entityUrl: b.entityUrl,
    runId: b.runId,
    toolUseId: b.toolUseId,
    idempotencyKey: b.idempotencyKey,
    signal: b.signal,
    platform,
  });

  const harness = createPiHarness({
    ctx: new MemCtx(),
    client,
    toolContext: platformFactory,
    systemPrompt: args.systemPrompt,
    maxSteps: 5, // token guard: a correct run is 2 steps (spawn → wait/finish)
  });

  const result = await harness.run(input);

  const toolSequence = committed
    .filter((e) => e.type === "tool_call")
    .map((e) => (e.payload as { name: string }).name);
  const assistantText = committed
    .filter((e) => e.type === "message" && (e.payload as { role: string }).role === "assistant")
    .flatMap((e) => (e.payload as { content: Array<{ text?: string }> }).content)
    .map((b) => b.text ?? "")
    .filter((t) => t.length > 0);
  const deltaKinds: Record<string, number> = {};
  for (const d of deltas) deltaKinds[d.kind] = (deltaKinds[d.kind] ?? 0) + 1;
  const runFinished = committed.find((e) => e.type === "run_finished");

  return {
    provider: args.provider,
    model: args.model,
    toolSequence,
    spawns: platform.spawns,
    sends: platform.sends,
    listChildrenCalls: platform.listChildrenCalls,
    assistantText,
    deltaKinds,
    llmSteps: result.usage.steps ?? 0,
    outcome: (runFinished?.payload as { outcome?: string } | undefined)?.outcome ?? "unknown",
    events: committed.map((e) => ({ type: e.type, payload: e.payload })),
  };
}

function writeTranscript(name: string, outcome: SoakOutcome): void {
  mkdirSync(NOTES_DIR, { recursive: true });
  writeFileSync(join(NOTES_DIR, name), JSON.stringify(outcome, null, 2), "utf8");
}

// The orchestrator system prompt: describes the async model in one line, then
// relies on the TOOL DESCRIPTIONS to carry the teaching (the thing under test).
const ORCH_SYSTEM =
  "You are an orchestrator agent in an asynchronous multi-agent runtime. You coordinate work " +
  "by spawning child agents and reacting to messages on later wakes. Use the provided tools.";

// The trap: "then report the findings" tempts the model to expect the child's
// result NOW. Correct async behavior: spawn the child, then yield (call `wait`)
// — the result will arrive later as a child_finished message on a future wake.
const ORCH_WAKE =
  "Research the history of tea. Spawn a 'researcher' child agent (pass the topic in args), " +
  "then report the research findings.";

interface ProviderCase {
  name: string;
  provider: "google" | "opencode-go";
  model: string;
  key: string | undefined;
}

const CASES: ProviderCase[] = [
  { name: "google", provider: "google", model: "gemini-flash-lite-latest", key: GEMINI },
  { name: "opencode-go", provider: "opencode-go", model: "deepseek-v4-flash", key: OPENCODE },
];

for (const c of CASES) {
  describe.skipIf(!c.key)(`pi soak — ${c.name} (${c.model})`, () => {
    it(
      "streams cleanly through the real harness loop (stream-fallback evidence)",
      { timeout: 180_000 },
      async () => {
        const outcome = await runScenario({
          provider: c.provider,
          model: c.model,
          apiKey: c.key!,
          wakeText: ORCH_WAKE,
          systemPrompt: ORCH_SYSTEM,
          label: `${c.name}-orchestrator`,
        });
        writeTranscript(`soak-${c.name}.json`, outcome);

        // (b) Streaming works end-to-end: the run completed and streaming
        // deltas actually arrived (proving streamSimple yields usable
        // fragments — no need for the buffered path).
        expect(outcome.outcome).not.toBe("error");
        expect(outcome.llmSteps).toBeGreaterThan(0);
        const totalDeltas = Object.values(outcome.deltaKinds).reduce((a, b) => a + b, 0);
        expect(totalDeltas).toBeGreaterThan(0);

        // (c) The model engaged the platform tools (spawn/wait/finish); the
        // specific SEQUENCE is the ergonomics signal recorded in the
        // transcript for the tuning analysis.
        expect(outcome.toolSequence.length).toBeGreaterThan(0);
        console.log(
          `[soak ${c.name}] tools=${JSON.stringify(outcome.toolSequence)} spawns=${String(
            outcome.spawns.length,
          )} listChildren=${String(outcome.listChildrenCalls)} deltas=${JSON.stringify(
            outcome.deltaKinds,
          )} steps=${String(outcome.llmSteps)} outcome=${outcome.outcome}`,
        );
      },
    );
  });
}
