/**
 * Live-stack driver (T6.3) — the shared harness the live end-to-end scenarios
 * and T9.1's chaos suite use to DRIVE a running teaspill stack and OBSERVE the
 * outcome, through the developer-facing surfaces only:
 *
 *   - drive:    `@teaspill/frontend-sdk` actions client → gateway `/api/*`
 *               (spawn / send / control), which is `@teaspill/agents-sdk`'s
 *               server-side entrypoint.
 *   - observe:  `createAgentTimeline` → gateway `/streams/*` → the reducer's
 *               materialized collections and seq-gap (drift) detector.
 *
 * The whole live surface is GATED on `TEASPILL_STACK_URL`. With it unset (CI,
 * or anyone without a stack) `readStackConfig()` returns null and the live
 * suites `describe.skipIf` themselves out with a clear message. See README.md
 * for the run recipe and the conformance-agent contract the stack must satisfy.
 */

import {
  createActionsClient,
  createAgentTimeline,
  type ActionsClient,
  type AgentTimeline,
  type AgentTimelineOptions,
  type TeaspillAuth,
} from "@teaspill/frontend-sdk";
import type { TimelineEvent } from "@teaspill/schema";

// ---------------------------------------------------------------------------
// Configuration (env-gated)
// ---------------------------------------------------------------------------

/**
 * Agent types the conformance agents must be DEPLOYED as on the target stack
 * (developers `serve` agents satisfying the README contract). Overridable so a
 * stack that names them differently can still be exercised.
 */
export interface ConformanceAgentTypes {
  /** Echoes a message back and finishes (spawn→respond). */
  echo: string;
  /** Spawns `args.n` children in one wake and gathers all `child_finished`. */
  fanoutParent: string;
  /** A child that finishes immediately (spawned by the fan-out parent). */
  fanoutChild: string;
  /** Runs a long-ish exec then finishes (workspace-exec durability). */
  longExec: string;
}

export interface StackConfig {
  /** Gateway origin, e.g. `http://localhost:8080` (`TEASPILL_STACK_URL`). */
  baseUrl: string;
  /** API key for gateway writes (`TEASPILL_STACK_API_KEY`). */
  auth?: TeaspillAuth;
  agentTypes: ConformanceAgentTypes;
  /** Per-scenario wait ceiling in ms (`TEASPILL_STACK_TIMEOUT_MS`, default 30s). */
  timeoutMs: number;
}

export const DEFAULT_AGENT_TYPES: ConformanceAgentTypes = {
  echo: "conformance-echo",
  fanoutParent: "conformance-fanout-parent",
  fanoutChild: "conformance-fanout-child",
  longExec: "conformance-long-exec",
};

/**
 * Read the live-stack config from the environment. Returns `null` when
 * `TEASPILL_STACK_URL` is unset — the signal every live suite uses to skip.
 */
export function readStackConfig(env: NodeJS.ProcessEnv = process.env): StackConfig | null {
  const baseUrl = env["TEASPILL_STACK_URL"];
  if (baseUrl === undefined || baseUrl.trim() === "") return null;
  const apiKey = env["TEASPILL_STACK_API_KEY"];
  const timeoutRaw = env["TEASPILL_STACK_TIMEOUT_MS"];
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    ...(apiKey !== undefined && apiKey !== "" ? { auth: { apiKey } satisfies TeaspillAuth } : {}),
    agentTypes: {
      echo: env["TEASPILL_CONFORMANCE_ECHO_TYPE"] ?? DEFAULT_AGENT_TYPES.echo,
      fanoutParent: env["TEASPILL_CONFORMANCE_FANOUT_PARENT_TYPE"] ?? DEFAULT_AGENT_TYPES.fanoutParent,
      fanoutChild: env["TEASPILL_CONFORMANCE_FANOUT_CHILD_TYPE"] ?? DEFAULT_AGENT_TYPES.fanoutChild,
      longExec: env["TEASPILL_CONFORMANCE_LONG_EXEC_TYPE"] ?? DEFAULT_AGENT_TYPES.longExec,
    },
    timeoutMs: timeoutRaw !== undefined ? Number(timeoutRaw) : 30_000,
  };
}

/** Message shown by a skipped live suite so the reason is never a mystery. */
export const SKIP_MESSAGE =
  "live conformance scenario skipped — set TEASPILL_STACK_URL (and deploy the conformance agents; see README) to run it";

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface LiveDriver {
  readonly config: StackConfig;
  readonly actions: ActionsClient;
  /** Open a timeline reader for a canonical/short entity url or a gateway `streamUrl`. */
  openTimeline(streamUrl: string, opts?: AgentTimelineOptions): AgentTimeline;
  /**
   * Drive a timeline until `predicate(events)` holds or the stack timeout
   * elapses, then return the observed events. Rejects on drift (a seq gap is a
   * hard failure) or timeout. The workhorse behind every live scenario.
   */
  observeUntil(
    streamUrl: string,
    predicate: (events: readonly TimelineEvent[]) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<TimelineEvent[]>;
}

/** Build a live driver from a resolved `StackConfig`. */
export function createLiveDriver(config: StackConfig): LiveDriver {
  const actions = createActionsClient({
    baseUrl: config.baseUrl,
    ...(config.auth !== undefined && { auth: config.auth }),
  });

  const openTimeline = (streamUrl: string, opts?: AgentTimelineOptions): AgentTimeline =>
    createAgentTimeline(streamUrl, {
      ...(config.auth !== undefined && { auth: config.auth }),
      ...opts,
    });

  const observeUntil = (
    streamUrl: string,
    predicate: (events: readonly TimelineEvent[]) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<TimelineEvent[]> => {
    const timeoutMs = opts?.timeoutMs ?? config.timeoutMs;
    // `createAgentTimeline` folds events into typed collections and runs the
    // A6/D3 dedup + drift detector; it does not surface the raw ordered array,
    // so we reconstruct the events the checks inspect from those collections
    // (`reconstructEvents`) on every applied batch. Drift (a seq gap) is a hard
    // failure of the observed invariant, so it rejects.
    const timeline = openTimeline(streamUrl, {
      live: true,
      onDrift: (drift) => {
        settle(
          new Error(`drift detected (seq gap) observing ${streamUrl}: ${JSON.stringify(drift)}`),
        );
      },
    });

    let resolved = false;
    let resolveFn!: (events: TimelineEvent[]) => void;
    let rejectFn!: (err: unknown) => void;
    const result = new Promise<TimelineEvent[]>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    const collected = new Map<number, TimelineEvent>();
    const snapshotEvents = (): TimelineEvent[] =>
      [...collected.values()].sort((a, b) => a.seq - b.seq);

    function settle(err?: unknown): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      unsubscribe();
      timeline.close();
      if (err !== undefined) rejectFn(err);
      else resolveFn(snapshotEvents());
    }

    const unsubscribe = timeline.subscribe((state) => {
      for (const ev of reconstructEvents(state)) collected.set(ev.seq, ev);
      if (predicate(snapshotEvents())) settle();
    });

    const timer = setTimeout(() => {
      settle(
        new Error(
          `timed out after ${timeoutMs}ms observing ${streamUrl}; ` +
            `predicate unmet over ${collected.size} events`,
        ),
      );
    }, timeoutMs);

    return result;
  };

  return { config, actions, openTimeline, observeUntil };
}

// ---------------------------------------------------------------------------
// Reader-collections → ordered events (for the scenario checks)
// ---------------------------------------------------------------------------

/**
 * The frontend reducer folds events into typed collections rather than keeping
 * the raw ordered array. For the conformance CHECKS (which run over
 * `TimelineEvent[]`) we reconstruct the load-bearing events — the ones the
 * invariants inspect — from those collections. This intentionally covers only
 * the event types the scenarios assert on (spawned / message / run_finished /
 * child_spawned / child_finished); it is not a general inverse of the reducer.
 */
function reconstructEvents(
  state: import("@teaspill/frontend-sdk").AgentTimelineState,
): TimelineEvent[] {
  const t = state.timeline;
  const entityId = t.entityId ?? "";
  const events: TimelineEvent[] = [];
  const v = 1 as const;

  if (t.spawned !== null) {
    events.push({ v, entityId, seq: 0, ts: "", type: "entity_spawned", payload: t.spawned });
  }
  for (const m of t.messages) {
    events.push({
      v,
      entityId,
      seq: m.seq,
      ts: m.ts,
      type: "message",
      payload: {
        id: m.id,
        role: m.role,
        content: m.content,
        ...(m.runId !== undefined && { runId: m.runId }),
        ...(m.from !== undefined && { from: m.from }),
      },
    });
  }
  for (const r of t.runs) {
    if (r.finishedSeq !== undefined && r.outcome !== undefined) {
      events.push({
        v,
        entityId,
        seq: r.finishedSeq,
        ts: r.ts ?? "",
        type: "run_finished",
        payload: { runId: r.runId, outcome: r.outcome, usage: r.usage ?? { inputTokens: 0, outputTokens: 0 } },
      });
    }
  }
  for (const c of t.children) {
    if (c.spawnedSeq !== undefined) {
      events.push({
        v,
        entityId,
        seq: c.spawnedSeq,
        ts: "",
        type: "child_spawned",
        payload: {
          childId: c.childId,
          childType: c.childType ?? "",
          ...(c.runId !== undefined && { runId: c.runId }),
        },
      });
    }
    if (c.finishedSeq !== undefined && c.outcome !== undefined) {
      events.push({
        v,
        entityId,
        seq: c.finishedSeq,
        ts: "",
        type: "child_finished",
        payload: {
          childId: c.childId,
          outcome: c.outcome,
          ...(c.result !== undefined && { result: c.result }),
        },
      });
    }
  }
  return events.sort((a, b) => a.seq - b.seq);
}
