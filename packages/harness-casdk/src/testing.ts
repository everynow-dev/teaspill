/**
 * Offline test doubles + the canonical fixture timeline (0001:T7.1).
 *
 * NOT exported from the package index — tests (and 0001:T7.2's tests) deep-import
 * `./testing.js`. Everything here is deterministic: injected uuid counters
 * and clocks keep the golden fixtures byte-stable.
 */

import type { DeltaInit, TimelineEvent } from "@teaspill/schema";
import { finalizeEvent } from "@teaspill/schema";
import type {
  PlatformClient,
  SteerSource,
  ToolContext,
  ToolContextFactory,
} from "@teaspill/harness-native";
import type {
  CasdkQueryInput,
  CasdkSdkClient,
  SdkStreamRecord,
  SdkUserInputMessage,
} from "./sdk-client.js";
import type { SessionLine } from "./session-lines.js";

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

export function seqUuid(prefix = "uuid"): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, "0")}`;
}

/** Fixed-start, +1s-per-call clock. */
export function tickingNow(startMs = 1_760_000_000_000): () => number {
  let t = startMs - 1000;
  return () => (t += 1000);
}

export const FIXTURE_ENTITY = "/t/default/a/researcher/r1";
export const FIXTURE_BASE_MS = 1_750_000_000_000;

// ---------------------------------------------------------------------------
// Canonical fixture timeline (golden + projection + harness tests)
// ---------------------------------------------------------------------------

/**
 * A timeline exercising every projection rule: user/assistant/system_note
 * messages, display-only reasoning, a tool round-trip (with tool-layer
 * `detail`), an opaque casdk session line, non-context events, and a trailing
 * user wake (the feed split).
 */
export function fixtureTimeline(): TimelineEvent[] {
  const ts = (i: number): string => new Date(FIXTURE_BASE_MS + i * 1000).toISOString();
  const inits = [
    { type: "entity_spawned", ts: ts(0), payload: { entityType: "researcher", parentId: null } },
    {
      type: "run_started",
      ts: ts(1),
      payload: { runId: "run-a", wake: { source: "spawn" }, harness: "casdk", model: "m" },
    },
    {
      type: "message",
      ts: ts(2),
      payload: { id: "wake-run-a", runId: "run-a", role: "user", content: [{ type: "text", text: "Find the launch date." }] },
    },
    {
      type: "reasoning",
      ts: ts(3),
      payload: { id: "rsn-run-a-s0", runId: "run-a", text: "Let me search." },
    },
    {
      type: "message",
      ts: ts(4),
      payload: { id: "msg-run-a-s0", runId: "run-a", role: "assistant", content: [{ type: "text", text: "I'll look it up." }] },
    },
    {
      type: "tool_call",
      ts: ts(5),
      payload: { runId: "run-a", toolUseId: "toolu_001", name: "web_search", input: { query: "launch date" } },
    },
    {
      type: "tool_result",
      ts: ts(6),
      payload: {
        runId: "run-a",
        toolUseId: "toolu_001",
        name: "web_search",
        content: [{ type: "text", text: "March 14" }],
        detail: { source: "cache" },
        isError: false,
      },
    },
    {
      type: "message",
      ts: ts(7),
      payload: { id: "msg-run-a-s1", runId: "run-a", role: "assistant", content: [{ type: "text", text: "The launch date is March 14." }] },
    },
    {
      type: "message",
      ts: ts(8),
      payload: { id: "note-1", role: "system_note", content: [{ type: "text", text: "child /t/default/a/worker/w1 finished: ok" }] },
    },
    {
      type: "opaque",
      ts: ts(9),
      payload: {
        origin: "casdk",
        kind: "session/queue-operation",
        data: { type: "queue-operation", operation: "dequeue" },
      },
    },
    {
      type: "run_finished",
      ts: ts(10),
      payload: { runId: "run-a", outcome: "success", usage: { inputTokens: 10, outputTokens: 5 } },
    },
    {
      type: "message",
      ts: ts(11),
      payload: { id: "wake-run-b", runId: "run-b", role: "user", content: [{ type: "text", text: "Now summarize our findings." }] },
    },
  ] as const;
  return inits.map((init, seq) =>
    finalizeEvent(init as never, { entityId: FIXTURE_ENTITY, seq }),
  );
}

// ---------------------------------------------------------------------------
// Steer / delta / tool-context doubles
// ---------------------------------------------------------------------------

export function emptySteerSource(): SteerSource {
  return { drain: async () => [] };
}

/** Drains `queues[i]` on the i-th call, [] after. */
export function scriptedSteerSource(
  queues: Awaited<ReturnType<SteerSource["drain"]>>[],
): SteerSource & { drains: number } {
  const src = {
    drains: 0,
    async drain() {
      const q = queues[src.drains] ?? [];
      src.drains += 1;
      return q;
    },
  };
  return src;
}

export function collectingDelta(): { deltas: DeltaInit[]; emit: (d: DeltaInit) => void } {
  const deltas: DeltaInit[] = [];
  return { deltas, emit: (d) => deltas.push(d) };
}

export function fakeToolContextFactory(): ToolContextFactory & {
  calls: Array<{ toolUseId: string; idempotencyKey: string }>;
} {
  const calls: Array<{ toolUseId: string; idempotencyKey: string }> = [];
  const platform: PlatformClient = {
    spawn: async () => ({ entityId: "/t/default/a/x/child" }),
    send: async () => undefined,
    listChildren: async () => [],
  };
  const factory = Object.assign(
    (binding: {
      entityUrl: string;
      runId: string;
      toolUseId: string;
      idempotencyKey: string;
      signal: AbortSignal;
    }): ToolContext => {
      calls.push({ toolUseId: binding.toolUseId, idempotencyKey: binding.idempotencyKey });
      return {
        entityUrl: binding.entityUrl,
        runId: binding.runId,
        toolUseId: binding.toolUseId,
        idempotencyKey: binding.idempotencyKey,
        signal: binding.signal,
        platform,
      };
    },
    { calls },
  );
  return factory;
}

// ---------------------------------------------------------------------------
// Fake SDK client
// ---------------------------------------------------------------------------

export interface FakeSdkTurnContext {
  turn: number;
  options: CasdkQueryInput["options"];
  sessionId: string;
}

export interface FakeSdkClientOptions {
  /** Records to yield for the i-th user input (append a `result` per turn). */
  respond: (msg: SdkUserInputMessage, ctx: FakeSdkTurnContext) => Promise<SdkStreamRecord[]> | SdkStreamRecord[];
  /** session_id for the init record. Default: `options.resume` else `fresh-<n>`. */
  sessionIdFor?: (options: CasdkQueryInput["options"]) => string;
  /** Emulate the SDK's dual-write mirror through options.sessionStore. */
  mirror?: boolean;
}

export interface FakeSdkCall {
  options: CasdkQueryInput["options"];
  fedInputs: SdkUserInputMessage[];
  loadedLines: SessionLine[] | null;
  sessionId: string;
}

/**
 * Scripted stand-in for `query()`. Emulates the 0.3.211 behaviors the harness
 * depends on: one `system`/`init` first (echoing `resume` as the session id),
 * `sessionStore.load()` called once pre-"spawn" when resuming, per-input
 * response records, optional mirror appends, and an abort throw.
 */
export function createFakeSdkClient(
  script: FakeSdkClientOptions,
): CasdkSdkClient & { calls: FakeSdkCall[] } {
  let fresh = 0;
  const calls: FakeSdkCall[] = [];
  return {
    calls,
    query(input: CasdkQueryInput): AsyncIterable<SdkStreamRecord> {
      const options = input.options;
      const sessionId =
        script.sessionIdFor?.(options) ?? options.resume ?? `fresh-${String(++fresh)}`;
      const call: FakeSdkCall = { options, fedInputs: [], loadedLines: null, sessionId };
      calls.push(call);

      async function* run(): AsyncGenerator<SdkStreamRecord> {
        const projectKey = "fake-project";
        if (options.resume !== undefined && options.sessionStore) {
          call.loadedLines = await options.sessionStore.load({
            projectKey,
            sessionId: options.resume,
          });
        }
        yield { type: "system", subtype: "init", session_id: sessionId } as SdkStreamRecord;

        const mirror = async (lines: SessionLine[]): Promise<void> => {
          if (script.mirror && options.sessionStore) {
            await options.sessionStore.append({ projectKey, sessionId }, lines);
          }
        };

        const feed = async function* (): AsyncGenerator<SdkUserInputMessage> {
          if (typeof input.prompt === "string") {
            yield {
              type: "user",
              message: { role: "user", content: [{ type: "text", text: input.prompt }] },
              parent_tool_use_id: null,
            };
            return;
          }
          yield* input.prompt;
        };

        let turn = 0;
        for await (const msg of feed()) {
          if (options.abortController.signal.aborted) {
            throw new Error("Claude Code process aborted by user");
          }
          call.fedInputs.push(msg);
          await mirror([
            {
              type: "user",
              uuid: `fake-mirror-u${String(turn)}`,
              parentUuid: null,
              timestamp: new Date().toISOString(),
              message: msg.message as SessionLine["message"],
            },
          ]);
          const records = await script.respond(msg, { turn, options, sessionId });
          for (const r of records) {
            if (options.abortController.signal.aborted) {
              throw new Error("Claude Code process aborted by user");
            }
            if (r.type === "assistant") {
              const rec = r as { message?: { content?: unknown } };
              await mirror([
                {
                  type: "assistant",
                  uuid: `fake-mirror-a${String(turn)}-${String(Math.random()).slice(2, 8)}`,
                  parentUuid: null,
                  timestamp: new Date().toISOString(),
                  message: rec.message as SessionLine["message"],
                },
              ]);
            }
            yield { ...r, session_id: sessionId };
          }
          turn += 1;
        }
      }
      return run();
    },
  };
}

// ---------------------------------------------------------------------------
// Common fake stream records
// ---------------------------------------------------------------------------

export function assistantText(text: string, apiId = "api-msg-1"): SdkStreamRecord {
  return {
    type: "assistant",
    message: { id: apiId, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } },
    parent_tool_use_id: null,
  } as SdkStreamRecord;
}

export function resultSuccess(text = "done"): SdkStreamRecord {
  return {
    type: "result",
    subtype: "success",
    result: text,
    total_cost_usd: 0.01,
    usage: { input_tokens: 999, output_tokens: 999 },
  } as SdkStreamRecord;
}
