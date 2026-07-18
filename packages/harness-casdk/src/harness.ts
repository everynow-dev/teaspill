/**
 * CasdkHarness (0001:T7.1) — the Claude Agent SDK harness implementing the FROZEN
 * `Harness.run` (0001:T3.1) via 0001:D5's three durability layers:
 *
 * 1. **Effects** — tools execute through the 0001:T7.2 seam (`tool-seam.ts`) whose
 *    handlers route every side effect through Restate ingress with the
 *    exactly-once idempotency key `(entityUrl, runId, toolUseId)`.
 * 2. **Continuation** — the durable session (`session-store.ts`, mirrored via
 *    the SDK's `@alpha` SessionStore) is the intra-run journal. WARM PATH
 *    (validated live against the pinned SDK, see below): seq stamp matches →
 *    `resume` the stored session and feed the wake via streaming input; a
 *    crashed-and-retried `ctx.run` re-resumes the SAME session (whose mirror
 *    already holds the crashed attempt's progress) and continues.
 * 3. **Truth** — canonical is authority. Capture (capture.ts) translates the
 *    run's stream to `TimelineEventInit`s returned for outbox commit; COLD
 *    PATH (projection.ts) rebuilds the session from canonical whenever
 *    trust-but-verify fails.
 *
 * ## Warm-vs-cold decision (trust-but-verify, 0001:D5 layer 3)
 *
 * `decideRunPlan` is pure. WARM requires ALL of:
 * - stored meta exists, `forceCold` is off, and meta.sdkVersion is the
 *   pinned/supported version (drift → cold, 0001:R3);
 * - `meta.seqStamp <= head` and every context-bearing event AFTER the stamp
 *   is user-feedable (user/system_note messages — i.e. exactly the wake
 *   input the handler pre-committed). Assistant/tool/summarization events
 *   after the stamp mean the session no longer reflects canonical → cold.
 *   `seqStamp > head` (crash between meta save and outbox commit) → cold;
 * - the stored transcript is present and non-empty.
 * Additionally at RUN time: the SDK echoing a different session id than the
 * one resumed (silent fresh session) fails the run loudly, clears meta, and
 * the retry cold-rebuilds; a dropped mirror batch (`mirror_error`) taints
 * the session so the NEXT wake cold-rebuilds.
 *
 * ## Whole-run journaling
 *
 * Unlike the step-durable native harness, `run()` here executes inside ONE
 * `ctx.run` of the agent handler (the SDK owns the loop — there are no
 * journalable step boundaries). All events return at the end (0001:T3.1 invariant
 * 3; `commitEvents` is not used). The seq stamp is saved PREDICTIVELY
 * (head + events.length) before returning — a crash before the outbox commit
 * leaves stamp > head, which reads as mismatch → safe cold rebuild.
 */

import { randomUUID } from "node:crypto";
import type { JsonValue, TimelineEvent, TimelineEventInit, WakeSource } from "@teaspill/schema";
import type {
  AnyToolDefinition,
  Harness,
  HarnessRunInput,
  HarnessRunResult,
  SteerMessage,
  ToolContextFactory,
} from "@teaspill/harness-native";
import { CaptureState } from "./capture.js";
import { projectCanonicalToSession, isUserFeedable } from "./projection.js";
import type { CasdkQueryOptions, CasdkSdkClient, SdkUserInputMessage } from "./sdk-client.js";
import { PINNED_SDK_VERSION } from "./sdk-client.js";
import type { CasdkSessionMeta, CasdkSessionStore } from "./session-store.js";
import { toSdkSessionStore } from "./session-store.js";
import type { CasdkToolServer, CasdkToolServerBinding, CasdkToolServerFactory } from "./tool-seam.js";
import { noToolServer } from "./tool-seam.js";
import { contentToSessionBlocks, getTranslation } from "./translation.js";
import { SYSTEM_NOTE_MARKER } from "@teaspill/harness-native";

// ===========================================================================
// Options
// ===========================================================================

export interface CasdkHarnessOptions {
  /** Durable session storage (0001:D5 layer 2). File store in prod; memory in tests. */
  store: CasdkSessionStore;
  /** The SDK query seam. Real: `createClaudeAgentSdkClient()`; tests: fake. */
  sdk: CasdkSdkClient;
  /**
   * 0001:T7.2's in-process MCP tool server factory. Default: no tools. May be
   * ASYNC: the real factory (agents-sdk wiring) lazily loads the SDK-MCP api
   * on first use, so it resolves a `CasdkToolServer` off a promise — `run()`
   * awaits it before assembling the query options.
   */
  toolServer?: CasdkToolServerFactory | ((binding: CasdkToolServerBinding) => Promise<CasdkToolServer>);
  /** Per-call ToolContext factory (0001:T3.1 idempotency contract) for the tool server. */
  toolContext?: ToolContextFactory;
  model: string;
  /** Fully custom bare system prompt (replaces the Claude Code preset). */
  systemPrompt?: string;
  /** Must match a translation-table branch; default = the pinned version. */
  sdkVersion?: string;
  /**
   * Ops lever: cold-rebuild-every-wake (the 0001:D5-sanctioned degraded mode /
   * electric-spike architecture). Warm path stays default — it is validated
   * against the pinned SDK — but a deployment can flip this without a code
   * change if an SDK bump misbehaves.
   */
  forceCold?: boolean;
  /** True wake source/sender for run_started (handler passes wakeMessage null). */
  wakeSource?: WakeSource;
  wakeFrom?: string;
  maxTurns?: number;
  /** Streaming-delta capture (default true; partial messages → delta channel). */
  includePartialMessages?: boolean;
  /** Subprocess env/cwd overrides (0001:T7.3 packaging wires these). */
  env?: Record<string, string>;
  cwd?: string;
  /** Injected clock/uuid (determinism in tests). */
  now?: () => number;
  newUuid?: () => string;
}

/** Continuation state mirrored into agent K/V (`stateDelta.harness`). */
export interface CasdkHarnessState {
  sessionId: string;
  seqStamp: number;
  mode: "warm" | "cold";
  [k: string]: JsonValue | undefined;
}

// ===========================================================================
// Warm/cold planning (pure)
// ===========================================================================

export type RunPlan =
  | { mode: "warm"; sessionId: string; feedEvents: TimelineEvent[] }
  | { mode: "cold"; reason: string };

export function headSeq(events: readonly TimelineEvent[]): number {
  return events.length > 0 ? events[events.length - 1]!.seq : -1;
}

export function decideRunPlan(args: {
  meta: CasdkSessionMeta | null;
  canonicalContext: readonly TimelineEvent[];
  sdkVersion: string;
  forceCold: boolean;
  hasLines: boolean;
}): RunPlan {
  const { meta, canonicalContext, sdkVersion, forceCold, hasLines } = args;
  if (forceCold) return { mode: "cold", reason: "force_cold" };
  if (!meta) return { mode: "cold", reason: "no_session_meta" };
  if (meta.sdkVersion !== sdkVersion) {
    return { mode: "cold", reason: `sdk_version_changed:${meta.sdkVersion}->${sdkVersion}` };
  }
  const head = headSeq(canonicalContext);
  if (meta.seqStamp > head) return { mode: "cold", reason: "stamp_ahead_of_head" };
  const after = canonicalContext.filter((ev) => ev.seq > meta.seqStamp);
  for (const ev of after) {
    const contextBearing =
      ev.type === "message" ||
      ev.type === "tool_call" ||
      ev.type === "tool_result" ||
      ev.type === "summarization" ||
      (ev.type === "opaque" && ev.payload.origin === "casdk");
    if (contextBearing && !isUserFeedable(ev)) {
      return { mode: "cold", reason: `unfeedable_event_after_stamp:${ev.type}@${ev.seq}` };
    }
  }
  if (!hasLines) return { mode: "cold", reason: "session_lines_missing" };
  const feedEvents = after.filter(isUserFeedable);
  return { mode: "warm", sessionId: meta.sessionId, feedEvents };
}

// ===========================================================================
// Errors
// ===========================================================================

/** Thrown when a resume silently produced a fresh session (digest §3). The
 * harness clears session meta first, so the Restate retry cold-rebuilds. */
export class CasdkResumeMismatchError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(
      `CASDK resume mismatch: asked to resume session ${expected} but the SDK started ` +
        `${actual ?? "an unknown session"} — session meta cleared; retry will cold-rebuild`,
    );
    this.name = "CasdkResumeMismatchError";
  }
}

// ===========================================================================
// createCasdkHarness
// ===========================================================================

export function createCasdkHarness(opts: CasdkHarnessOptions): Harness {
  const sdkVersion = opts.sdkVersion ?? PINNED_SDK_VERSION;
  const table = getTranslation(sdkVersion); // throws on unsupported (0001:R3)
  const toolServerFactory = opts.toolServer ?? noToolServer();
  const now = opts.now ?? Date.now;
  const newUuid = opts.newUuid ?? randomUUID;
  const iso = (ms: number): string => new Date(ms).toISOString();

  return {
    kind: "casdk",

    async run(input: HarnessRunInput): Promise<HarnessRunResult> {
      const { entityId, runId, canonicalContext } = input;
      const startedAt = now();
      const head = headSeq(canonicalContext);

      // ----- plan: warm resume vs cold rebuild ------------------------------
      const meta = await opts.store.loadMeta(entityId);
      const storedLines =
        meta === null ? null : await opts.store.loadLines(entityId, meta.sessionId);
      const plan = decideRunPlan({
        meta,
        canonicalContext,
        sdkVersion,
        forceCold: opts.forceCold ?? false,
        hasLines: storedLines !== null && storedLines.length > 0,
      });

      let sessionId: string;
      let resume: string | undefined;
      let feedEvents: TimelineEvent[];
      let idMap: CasdkSessionMeta["idMap"];
      let coldReason: string | undefined;

      /** Warm RETRY of a crashed attempt — the wake may already be in the session. */
      let retryOfPendingRun = false;
      if (plan.mode === "warm") {
        sessionId = plan.sessionId;
        resume = sessionId;
        feedEvents = plan.feedEvents;
        idMap = meta!.idMap;
        retryOfPendingRun = meta!.pendingRun?.runId === runId;
        // Mark the run in-flight BEFORE the query starts, so a crashed-and-
        // retried ctx.run can tell "this wake was (possibly) already fed".
        await opts.store.saveMeta(entityId, {
          ...meta!,
          pendingRun: { runId },
          updatedAt: iso(startedAt),
        });
      } else {
        coldReason = plan.reason;
        const projection = projectCanonicalToSession(canonicalContext, {
          newUuid,
          baseTimeMs: startedAt,
        });
        feedEvents = projection.feedEvents;
        idMap = projection.idMap;
        if (projection.lines.length > 0) {
          sessionId = newUuid();
          resume = sessionId;
          await opts.store.replaceLines(entityId, sessionId, projection.lines);
        } else {
          // Nothing to resume — a genuinely fresh session; the SDK mints the
          // id (learned from init) and load() is never called.
          sessionId = "";
          resume = undefined;
        }
      }

      // ----- tool server (Effects seam; 0001:T7.2 provides the real MCP server) --
      // The factory may be async (the real MCP server lazily loads the SDK-MCP
      // api) — await covers both sync (fake) and async (real) factories.
      const toolServer = await toolServerFactory({
        entityId,
        runId,
        signal: input.signal,
        tools: input.tools as readonly AnyToolDefinition[],
        toolContext:
          opts.toolContext ??
          (() => {
            throw new Error("harness-casdk: toolContext factory not wired (agents-sdk provides it)");
          }),
      });

      // ----- capture state (Truth) -----------------------------------------
      const capture = new CaptureState({
        entityId,
        runId,
        attempt: input.attempt,
        table,
        emitDelta: input.emitDelta,
        detail: toolServer.detail,
        expectedSessionId: resume,
        now,
        foldBoundarySeq: head >= 0 ? head : undefined,
      });

      // ----- events: run_started + wake/steer messages ----------------------
      const events: TimelineEventInit[] = [];
      const wakeSource: WakeSource = opts.wakeSource ?? input.wakeMessage?.source ?? "message";
      const wakeFrom = input.wakeMessage?.from ?? opts.wakeFrom;
      events.push({
        type: "run_started",
        ts: iso(startedAt),
        payload: {
          runId,
          wake: { source: wakeSource, ...(wakeFrom !== undefined && { from: wakeFrom }) },
          harness: "casdk",
          model: opts.model,
          detail: {
            mode: plan.mode,
            ...(coldReason !== undefined && { coldReason }),
            ...(resume !== undefined && { sessionId: resume }),
          },
        },
      });

      if (input.wakeMessage !== null) {
        // Non-null wake input: commit it as canonical (pre-commit handlers
        // pass null with the wake already in canonicalContext).
        const wm = input.wakeMessage;
        events.push({
          type: "message",
          ts: iso(startedAt),
          payload: {
            id: `wake-${runId}`,
            runId,
            role: "user",
            content: [...wm.content],
            ...(wm.from !== undefined && { from: wm.from }),
          },
        });
      }

      // ----- streaming input: wake feed + steer injection -------------------
      // The input queue stays open across turns; after each SDK `result` the
      // steerbox is drained — pending steers feed the next turn, an empty
      // steerbox closes the queue and ends the run (0001:T7.2 refines cadence).
      const inputQueue: SdkUserInputMessage[] = [];
      let queueClosed = false;
      let queueWaiter: (() => void) | null = null;
      const pushInput = (content: unknown): void => {
        inputQueue.push({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          session_id: sessionId,
        });
        queueWaiter?.();
      };
      const closeQueue = (): void => {
        queueClosed = true;
        queueWaiter?.();
      };
      async function* promptStream(): AsyncGenerator<SdkUserInputMessage> {
        for (;;) {
          while (inputQueue.length > 0) yield inputQueue.shift()!;
          if (queueClosed) return;
          await new Promise<void>((res) => {
            queueWaiter = res;
          });
          queueWaiter = null;
        }
      }

      // Initial feed: trailing canonical user events (warm: everything after
      // the stamp; cold: the split tail) + a non-null wakeMessage. On a warm
      // RETRY the crashed attempt may already have fed these into the
      // session, so they are re-fed wrapped in an explicit restart marker —
      // harmless if duplicated (clearly labeled), lossless if the crash
      // happened before delivery (validated live: 0001:T7.1 experiments B/C).
      const feedBlocks: unknown[] = [];
      for (const ev of feedEvents) {
        if (ev.type !== "message") continue;
        feedBlocks.push(
          ev.payload.role === "system_note"
            ? [
                {
                  type: "text" as const,
                  text: `${SYSTEM_NOTE_MARKER} ${ev.payload.content
                    .filter((b): b is Extract<(typeof ev.payload.content)[number], { type: "text" }> => b.type === "text")
                    .map((b) => b.text)
                    .join("\n")}`,
                },
              ]
            : contentToSessionBlocks(ev.payload.content),
        );
      }
      if (input.wakeMessage !== null) {
        feedBlocks.push(contentToSessionBlocks(input.wakeMessage.content));
      }
      if (retryOfPendingRun) {
        const originals = feedBlocks
          .flatMap((blocks) => blocks as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
        pushInput([
          {
            type: "text",
            text:
              `${SYSTEM_NOTE_MARKER} process restarted — continue this wake. ` +
              `You may re-issue any interrupted tool call. Original input (may repeat what you already saw):\n${originals}`,
          },
        ]);
      } else {
        for (const blocks of feedBlocks) pushInput(blocks);
        if (inputQueue.length === 0) {
          // A continuation wake with nothing new to say — nudge forward.
          pushInput([{ type: "text", text: `${SYSTEM_NOTE_MARKER} continue` }]);
        }
      }

      // ----- abort wiring ---------------------------------------------------
      const abortController = new AbortController();
      const onAbort = (): void => {
        abortController.abort();
        closeQueue();
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });

      // ----- query options (the spike-verified minimum headless config) -----
      const sdkStore = toSdkSessionStore(opts.store, { entityId, newUuid, now });
      const queryOptions: CasdkQueryOptions = {
        model: opts.model,
        systemPrompt: opts.systemPrompt ?? "",
        tools: [], // AUTHORITATIVE built-in disable (digest §1.4)
        permissionMode: "bypassPermissions",
        settingSources: [],
        ...(resume !== undefined && { resume }),
        sessionStore: sdkStore,
        sessionStoreFlush: "eager",
        mcpServers: toolServer.mcpServers,
        allowedTools: toolServer.allowedTools,
        includePartialMessages: opts.includePartialMessages ?? true,
        abortController,
        ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
        hooks: {
          // Observer ONLY (0001:D5): PostCompact is the sole source of the SDK's
          // compaction summary text (digest §1.3).
          PostCompact: [
            {
              hooks: [
                async (hookInput: { compact_summary?: string }): Promise<Record<string, never>> => {
                  if (typeof hookInput.compact_summary === "string") {
                    capture.onCompactSummary(hookInput.compact_summary);
                  }
                  return {};
                },
              ],
            },
          ],
        },
        ...(opts.env !== undefined && { env: opts.env }),
        ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      };

      // ----- drive the run --------------------------------------------------
      let aborted = false;
      let runError: unknown;
      try {
        const stream = opts.sdk.query({ prompt: promptStream(), options: queryOptions });
        for await (const record of stream) {
          capture.onRecord(record);
          if (record.type === "result") {
            // Turn boundary: drain the steerbox; feed or finish.
            let steered: SteerMessage[] = [];
            try {
              steered = input.signal.aborted ? [] : await input.steerSource.drain();
            } catch {
              steered = []; // drain failure must not kill the run
            }
            if (steered.length > 0) {
              for (const m of steered) {
                // Interleaved at the live stream position (ordering matches
                // what the model saw), committed with the captured events.
                capture.pushExternalEvent({
                  type: "message",
                  ts: m.ts,
                  payload: {
                    id: m.id,
                    runId,
                    role: "user",
                    content: [...m.content],
                    ...(m.from !== undefined && { from: m.from }),
                  },
                });
                pushInput(contentToSessionBlocks(m.content));
              }
            } else {
              closeQueue();
            }
          }
        }
      } catch (err) {
        if (input.signal.aborted || abortController.signal.aborted) {
          aborted = true; // SDK abort surfaces as a throw — a normal outcome
        } else {
          runError = err;
        }
      } finally {
        closeQueue();
        input.signal.removeEventListener("abort", onAbort);
        await toolServer.close?.().catch(() => undefined);
      }

      const captured = capture.finish();
      events.push(...captured.events);

      // ----- trust-but-verify outcomes -------------------------------------
      if (captured.resumeMismatch && resume !== undefined) {
        await opts.store.clearMeta(entityId);
        throw new CasdkResumeMismatchError(resume, captured.sessionId);
      }
      if (runError !== undefined) {
        // Run-level failure the harness could not convert into an error event
        // (e.g. subprocess spawn failure): clear nothing — the session store
        // is still consistent with canonical — and let Restate retry.
        throw runError;
      }

      const liveSessionId = captured.sessionId ?? sessionId;
      if (input.signal.aborted) aborted = true;

      // ----- run_finished ---------------------------------------------------
      const endedAt = now();
      const outcome: "success" | "error" | "interrupted" = aborted
        ? "interrupted"
        : captured.outcome === "error"
          ? "error"
          : "success";
      events.push({
        type: "run_finished",
        ts: iso(endedAt),
        payload: {
          runId,
          outcome,
          usage: captured.usage,
          durationMs: Math.max(0, endedAt - startedAt),
          ...(captured.initDetail !== undefined && { detail: { init: captured.initDetail } }),
        },
      });

      // ----- seq stamp (predictive) + meta save -----------------------------
      // The handler commits `events` in order right after we return, so the
      // new canonical head is head + events.length (0001:T3.1 invariant 3). A
      // crash in between leaves stamp > head → next wake reads mismatch →
      // cold rebuild. A tainted mirror also forces cold via cleared meta.
      const newStamp = head + events.length;
      if (captured.sessionTainted || liveSessionId === "") {
        await opts.store.clearMeta(entityId);
      } else {
        await opts.store.saveMeta(entityId, {
          sessionId: liveSessionId,
          seqStamp: newStamp,
          sdkVersion,
          idMap,
          updatedAt: iso(endedAt),
        });
      }

      const harnessState: CasdkHarnessState = {
        sessionId: liveSessionId,
        seqStamp: newStamp,
        mode: plan.mode,
      };
      return {
        events,
        stateDelta: {
          harness: harnessState as unknown as JsonValue,
          ...(captured.contextTokens !== undefined && { contextTokens: captured.contextTokens }),
        },
        usage: captured.usage,
      };
    },
  };
}
