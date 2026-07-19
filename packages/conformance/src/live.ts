/**
 * Live-stack driver (0001:T6.3) — the shared harness the live end-to-end scenarios
 * and 0001:T9.1's chaos suite use to DRIVE a running teaspill stack and OBSERVE the
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
  /** Injectable fetch for the driver's timeline reads (unit tests; default global). */
  fetch?: typeof globalThis.fetch;
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

/**
 * Margin added on top of the driver's observe window to cover the spawn/send
 * round-trips and reader shutdown that happen OUTSIDE `observeUntil`.
 */
export const LIVE_TEST_TIMEOUT_MARGIN_MS = 15_000;

/**
 * Vitest per-test timeout for a live scenario (0002:T4.2). The driver's
 * `observeUntil` window (`config.timeoutMs`, default 30s) is longer than
 * vitest's 5s default `testTimeout`, so every live `it(...)` MUST pass this as
 * its timeout argument — otherwise vitest kills the test before the driver's
 * own timeout can even fire (the exact first-live-run failure T4.2 hit: all 5
 * scenarios dead at 5000ms against a healthy stack).
 *
 * `observeCeilingMs` mirrors any explicit `{ timeoutMs }` the test passes to
 * `observeUntil` (e.g. exec-durability's `Math.max(timeoutMs, 60_000)`).
 */
export function liveTestTimeout(config: StackConfig | null, observeCeilingMs?: number): number {
  const base = observeCeilingMs ?? config?.timeoutMs ?? 30_000;
  return base + LIVE_TEST_TIMEOUT_MARGIN_MS;
}

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

/**
 * Resolve a gateway `streamUrl` against the stack's base url. The gateway
 * returns RELATIVE stream urls (`/streams/…`) — correct for browsers (same
 * origin) but fatal in Node, where `stream({ url })` has no base to resolve
 * against (0002:T4.2 live finding: every scenario sat at 0 events until
 * timeout). Absolute urls pass through untouched.
 */
export function resolveStreamUrl(streamUrl: string | URL, baseUrl: string): string {
  return new URL(String(streamUrl), baseUrl).toString();
}

/** Delay between reopen attempts while a timeline stream is not yet created. */
export const NOT_YET_CREATED_RETRY_MS = 250;

/**
 * True when a timeline-read failure means "the stream does not exist (yet)" —
 * the gateway proxies durable-streams' 404 for a stream that was never
 * PUT-created. The `@durable-streams/client` surfaces it as a `FetchError`
 * with a `status` field; we duck-type rather than import the class.
 */
export function isStreamNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

/** Build a live driver from a resolved `StackConfig`. */
export function createLiveDriver(config: StackConfig): LiveDriver {
  const actions = createActionsClient({
    baseUrl: config.baseUrl,
    ...(config.auth !== undefined && { auth: config.auth }),
  });

  const openTimeline = (streamUrl: string, opts?: AgentTimelineOptions): AgentTimeline =>
    createAgentTimeline(resolveStreamUrl(streamUrl, config.baseUrl), {
      ...(config.auth !== undefined && { auth: config.auth }),
      ...(config.fetch !== undefined && { fetch: config.fetch }),
      ...opts,
    });

  const observeUntil = (
    streamUrl: string,
    predicate: (events: readonly TimelineEvent[]) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<TimelineEvent[]> => {
    const timeoutMs = opts?.timeoutMs ?? config.timeoutMs;

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

    let timeline: AgentTimeline | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(err?: unknown): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (reopenTimer !== null) clearTimeout(reopenTimer);
      timeline?.close();
      if (err !== undefined) rejectFn(err);
      else resolveFn(snapshotEvents());
    }

    // The scenario checks run over the RAW event sequence, observed via the
    // reader's `onEvents` (0002:T4.2, additive — the reducer's collections are
    // deliberately lossy, e.g. no run_started, so reconstructing from them
    // broke every gapless invariant live). Reader dedup per 0001:A6: the FIRST
    // record for a canonical seq wins. Drift (a seq gap) is a hard failure of
    // the observed invariant, so it rejects.
    const openSession = (): void => {
      if (resolved) return;
      const session = openTimeline(streamUrl, {
        live: true,
        onDrift: (drift) => {
          settle(
            new Error(`drift detected (seq gap) observing ${streamUrl}: ${JSON.stringify(drift)}`),
          );
        },
        onEvents: (events) => {
          for (const ev of events) {
            if (!collected.has(ev.seq)) collected.set(ev.seq, ev); // A6 first-wins
          }
          if (predicate(snapshotEvents())) settle();
        },
      });
      timeline = session;

      // A transport failure before the read is even up to date is surfaced
      // here (0002:T4.2 live finding — previously it silently masqueraded as
      // a predicate timeout over 0 events). Two classes:
      //   - 404: the timeline stream does not exist YET — a spawn is accepted
      //     (202) before the first outbox flush PUT-creates the stream, so an
      //     immediate reader can race it. Retry until the overall deadline.
      //   - anything else (bad url, refused connection, 401…): FATAL — reject
      //     loudly right away.
      session.untilUpToDate().catch((error: unknown) => {
        if (resolved) return;
        if (isStreamNotFound(error)) {
          session.close();
          reopenTimer = setTimeout(openSession, NOT_YET_CREATED_RETRY_MS);
          return;
        }
        settle(
          new Error(
            `timeline read failed observing ${streamUrl}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        );
      });
    };

    const timer = setTimeout(() => {
      settle(
        new Error(
          `timed out after ${timeoutMs}ms observing ${streamUrl}; ` +
            `predicate unmet over ${collected.size} events`,
        ),
      );
    }, timeoutMs);

    openSession();
    return result;
  };

  return { config, actions, openTimeline, observeUntil };
}

// NOTE (0002:T4.2): the previous `reconstructEvents` helper — which rebuilt a
// partial event array from the reducer's lossy collections — is GONE. The
// driver now observes the raw parsed events via the reader's additive
// `onEvents` seam (frontend-sdk), which is the only faithful input for the
// gapless/exactly-once invariants.
