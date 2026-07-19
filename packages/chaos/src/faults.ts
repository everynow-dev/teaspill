/**
 * The failure-injection registry (0001:T9.1) — the 5 faults, each mapped to the
 * 0001:D2/0001:D3 INVARIANT it asserts (NOT merely "no crash"). This is the acceptance
 * test for 0001:D2/0001:D3: for each fault the suite (a) drives a conformance scenario,
 * (b) injects the fault mid-flight via the fault driver, then (c) re-asserts the
 * mapped invariant with the conformance kit's `assert*` fns.
 *
 * Each `ChaosFault` names the conformance scenario it BUILDS ON (`scenarioId`,
 * whose pure `check` re-asserts the invariant), the DECISIONS anchors it
 * asserts, the fault-driver mechanism, and whether an OFFLINE invariant test
 * runs it in CI (against the real outbox / executor host + conformance's fakes)
 * or it is LIVE-only (needs the docker stack + process control).
 */

/** Which plane the fault kills, and how the driver injects it. */
export interface FaultInjection {
  /**
   * The service the driver targets. `agent-loop`/`executor` are
   * developer-deployed (0001:D4); `durable-streams`/`restate`/`gateway` are compose
   * services (0001:D6). Resolved to concrete names in `ChaosConfig.services`.
   */
  target: "agent-loop" | "executor" | "durable-streams" | "restate" | "gateway";
  /** `kill` = abrupt SIGKILL (crash); `restart` = kill+start; `stop-start` = graceful. */
  action: "kill" | "restart" | "stop-start";
  /** One-line description of the driver mechanism (docker compose / process handle). */
  mechanism: string;
}

export interface ChaosFault {
  /** Stable id (kebab-case) — tests and reports key off this. */
  id: string;
  title: string;
  /**
   * One-sentence statement of the 0001:D2/0001:D3 INVARIANT re-asserted after the fault.
   * This is the whole point: assert the invariant, not just no-crash.
   */
  invariant: string;
  /** DECISIONS anchors asserted (e.g. ["0001:A1", "0001:A4", "0001:D3"]). */
  asserts: readonly string[];
  /** The conformance scenario whose pure `check` re-asserts the invariant. */
  scenarioId: string;
  /** How the fault is injected. */
  injection: FaultInjection;
  /**
   * True ⇒ an OFFLINE invariant test exercises the CORE invariant in CI (real
   * outbox / executor host + conformance fakes). False ⇒ live-only (the
   * invariant needs real process control; see `liveOnlyReason`).
   */
  hasOfflineTest: boolean;
  /** For live-only faults, where the invariant IS exercised offline (if anywhere). */
  liveOnlyReason?: string;
}

export const AGENT_LOOP_KILL: ChaosFault = {
  id: "agent-loop-kill-mid-llm",
  title: "agent-loop killed mid-LLM-call",
  invariant:
    "After the agent-loop is killed mid-LLM-call and the run is retried, the run RESUMES and the projected timeline has NO duplicate events — exactly-once and seq-gapless (0001:A1/0001:A4 replay; a completed ctx.run is not re-run, its append dedups).",
  asserts: ["A1", "A4", "D3", "A6"],
  scenarioId: "crash-resume",
  injection: {
    target: "agent-loop",
    action: "kill",
    mechanism: "docker compose kill <agent-loop> (or process handle) mid-run; Restate re-dispatches the wake",
  },
  hasOfflineTest: true,
};

export const EXECUTOR_KILL: ChaosFault = {
  id: "executor-kill-mid-exec",
  title: "executor killed mid-exec",
  invariant:
    "When the executor is killed mid-exec the awaitable TIMES OUT (host-unresponsive backstop), an `error` event lands on the timeline (still seq-gapless), and the workspace is RECOVERABLE on a fresh exec (0001:A4 awakeable timeout, 0001:T4.1).",
  asserts: ["A4", "D4", "A1"],
  scenarioId: "workspace-exec-durability",
  injection: {
    target: "executor",
    action: "kill",
    mechanism: "docker compose kill <executor> (or process handle) while a long exec is in flight",
  },
  hasOfflineTest: true,
};

export const STREAMS_KILL: ChaosFault = {
  id: "streams-server-kill",
  title: "streams server killed",
  invariant:
    "With the streams server killed, runs PROCEED (control flow is Restate K/V, not streams — 0001:D1) and deltas drop; on streams recovery the outbox replays from the first-unconfirmed seq. Reader guarantee by crash window (0002:T4.3 live: SIGKILL loses the real server's producer-dedup state ENTIRELY — records survive, every producer restarts at expected-seq 0): untrimmed outbox ⇒ replay readmits acked appends as duplicate records and the reader's canonical-seq dedup covers them (0001:A6#2); trimmed outbox ⇒ replay is impossible (producer_gap drift), the reconciler executes the 0001:A9/0001:D3 catastrophic recovery, and the reader sees a timeline whose ONLY discontinuity is bridged by a state_snapshot(recovery, historyHole) — the sanctioned hole, with the entity healed for subsequent runs.",
  asserts: ["A6", "A1", "D1", "D3", "A9"],
  scenarioId: "projection-continuity",
  injection: {
    target: "durable-streams",
    action: "restart",
    mechanism: "docker compose kill durable-streams mid-run, then up -d to recover",
  },
  hasOfflineTest: true,
};

export const RESTATE_KILL: ChaosFault = {
  id: "restate-kill",
  title: "Restate killed",
  invariant:
    "Killing Restate FULLY STOPS coordination; on restart execution resumes CLEANLY with no state corruption — the K/V seq counter and outbox survive, replay is idempotent, and the timeline stays exactly-once and gapless (0001:A4 durable execution).",
  asserts: ["A4", "D2", "A1", "D3"],
  scenarioId: "crash-resume",
  injection: {
    target: "restate",
    action: "restart",
    mechanism: "docker compose kill restate (full stop), then up -d for a clean resume",
  },
  hasOfflineTest: true,
  liveOnlyReason:
    "the FULL-STOP durable-execution property is a Restate runtime guarantee (live-only); offline we exercise the durable-state half — K/V survives a modeled restart and replay is a clean idempotent no-op.",
};

export const GATEWAY_RESTART: ChaosFault = {
  id: "gateway-restart-mid-long-poll",
  title: "gateway restart mid-long-poll",
  invariant:
    "When the gateway restarts mid-long-poll the client RESUMES via the resumable protocol (offset-based re-read through the proxy): no bytes lost, none duplicated, continuity carried by the protocol not gateway state (0001:R5).",
  asserts: ["D6", "A1"],
  scenarioId: "spawn-respond",
  injection: {
    target: "gateway",
    action: "restart",
    mechanism: "docker compose restart gateway while a client long-poll is parked; client re-reads from its last offset",
  },
  hasOfflineTest: false,
  liveOnlyReason:
    "the offline version of THIS invariant already lives in packages/gateway/src/r5-streams.test.ts ('survives a GATEWAY restart mid-read') against a faithful fake upstream; those gateway test helpers are not exported, so here it is live-only against the real proxy.",
};

/** Every fault, in the PLAN 0001:T9.1 order. Keyed by `id`. */
export const FAULTS: readonly ChaosFault[] = [
  AGENT_LOOP_KILL,
  EXECUTOR_KILL,
  STREAMS_KILL,
  RESTATE_KILL,
  GATEWAY_RESTART,
];

/** Look up a fault by id (throws on unknown — ids are a stable contract). */
export function faultById(id: string): ChaosFault {
  const found = FAULTS.find((f) => f.id === id);
  if (!found) throw new Error(`unknown chaos fault ${JSON.stringify(id)}`);
  return found;
}
