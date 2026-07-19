/**
 * The deterministic onWake-only conformance agents (0002:T4.1, per
 * 0001:T6.3's documented contract in `packages/conformance/README.md` —
 * possible since 0001:A10 loop-wired `onWake`). NO LLM anywhere: every wake
 * is handled by a deterministic `onWake` returning `{ handled: true }`, all
 * I/O journaled through the `OnWakeContext` seam.
 *
 * ## Scenario map (which agent 0002:T4.2's 5 live scenarios drive)
 *
 * | conformance scenario        | agent(s)                                   | behavior exercised                                                |
 * |-----------------------------|--------------------------------------------|-------------------------------------------------------------------|
 * | `spawn-respond`             | `conformance-echo`                         | send `{text}` → assistant `message` echoing it + `run_finished`    |
 * | `parallel-fanout`           | `conformance-fanout-parent` + `-child`     | spawn `{n, childType}` children in ONE wake; children finish       |
 * |                             |                                            | immediately; ALL N `child_finished` land on the parent timeline    |
 * | `crash-resume`              | `conformance-echo`                         | any wake (the invariant is the outbox's exactly-once replay)       |
 * | `projection-continuity`     | `conformance-echo`                         | repeated sends across a streams restart (reader stays gapless)     |
 * | `workspace-exec-durability` | `conformance-long-exec`                    | send `{command}` → REAL workspace exec through the concrete        |
 * |                             |                                            | ingress client; `run_finished` only after the awaitable resolves   |
 *
 * ## Message shapes
 *
 * The live driver sends loose bodies (`{ text }`, `{ command }`); the
 * deployment normalizes them into canonical single-text-block messages
 * (./loose-message.ts), and structured bodies round-trip as JSON text — the
 * agents parse them back out of the last user message in `canonicalContext`.
 * Spawn args arrive the same way (handleSpawn renders args as a user message
 * with `JSON.stringify(args)`; `entity_spawned` itself is not
 * context-bearing).
 */

import { z } from "zod";
import { defineAgent, type AgentDefinition } from "@teaspill/agents-sdk";
import type { OnWakeContext, OnWakeOutcome } from "@teaspill/coordination";
import type { TimelineEvent } from "@teaspill/schema";
import { entityUrl, parseEntityUrl } from "@teaspill/schema";
import type { WorkspaceClient } from "@teaspill/harness-native";
import { onWakeOnlyHarness } from "./on-wake-harness.js";

// ---------------------------------------------------------------------------
// Types (the names the conformance kit drives; overridable via env there)
// ---------------------------------------------------------------------------

export const CONFORMANCE_TYPES = {
  echo: "conformance-echo",
  fanoutParent: "conformance-fanout-parent",
  fanoutChild: "conformance-fanout-child",
  longExec: "conformance-long-exec",
} as const;

// ---------------------------------------------------------------------------
// Wake-input helpers (pure; unit-tested)
// ---------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();

/** The text of the LAST user-role message in the bounded context (the wake input). */
export function lastUserText(context: readonly TimelineEvent[]): string | null {
  for (let i = context.length - 1; i >= 0; i--) {
    const ev = context[i]!;
    if (ev.type !== "message" || ev.payload.role !== "user") continue;
    const texts = ev.payload.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

/** Parse the last user message as JSON (loose bodies round-trip as JSON text). */
export function lastUserJson(context: readonly TimelineEvent[]): unknown {
  const text = lastUserText(context);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Addressing-charset-safe id derived from a (mixed-case) Restate run id. */
export function sanitizeInstanceId(raw: string, prefix: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const body = cleaned.replace(/^[_-]+/, "");
  return `${prefix}-${body || "x"}`.slice(0, 64);
}

async function emitAssistantText(wake: OnWakeContext, text: string): Promise<void> {
  const now = await wake.now();
  await wake.emit([
    {
      type: "message",
      ts: iso(now),
      payload: {
        id: `reply-${wake.runId}`,
        runId: wake.runId,
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface ConformanceAgentDeps {
  /** Deployment tenant (addressing §1). Default `"default"`. */
  tenant?: string;
  /**
   * Concrete `WorkspaceClient` factory for `conformance-long-exec` — the
   * deployment binds ./workspace-client.ts's ingress client to the entity's
   * private workspace + a wake-derived idempotency key; tests inject a fake.
   * Absent ⇒ the long-exec agent replies with an error message instead of
   * executing (it still finishes, so a mis-wired stack fails LOUDLY at the
   * conformance assert, not silently).
   */
  workspaceExec?: (bind: {
    entityUrl: string;
    runId: string;
    /** Spawn-chosen workspace key (0001:D4, via `OnWakeContext.workspaceRef` — additive 0002:T4.2). */
    workspaceRef?: string;
  }) => WorkspaceClient;
  /** Hard cap for the long-exec command (clamped by the workspace object anyway). */
  execTimeoutMs?: number;
}

const emptyState = z.object({});

/** `conformance-echo` — spawn-respond / crash-resume / projection-continuity. */
export function echoAgent(): AgentDefinition {
  return defineAgent({
    type: CONFORMANCE_TYPES.echo,
    state: emptyState,
    harness: onWakeOnlyHarness(),
    onWake: async (wake): Promise<OnWakeOutcome> => {
      if (wake.wakeSource === "spawn") return { handled: true }; // nothing to echo yet
      const text = lastUserText(wake.canonicalContext);
      await emitAssistantText(wake, text !== null ? `echo: ${text}` : "echo: (no text input)");
      return { handled: true };
    },
  });
}

const fanoutArgsSchema = z.object({
  n: z.number().int().min(1).max(64),
  childType: z.string().optional(),
});

/**
 * `conformance-fanout-parent` — parallel-fanout (the PERMANENT upstream
 * dropped-parent-wake regression): spawns `args.n` children of
 * `args.childType` in ONE wake; each later `child_finished` delivery is a
 * fresh wake whose pre-event is already on the timeline — the hook just
 * acknowledges it (gather-by-timeline, exactly what the scenario asserts).
 */
export function fanoutParentAgent(): AgentDefinition {
  return defineAgent({
    type: CONFORMANCE_TYPES.fanoutParent,
    spawnSchema: fanoutArgsSchema,
    state: emptyState,
    harness: onWakeOnlyHarness(),
    onWake: async (wake): Promise<OnWakeOutcome> => {
      if (wake.wakeSource !== "spawn") return { handled: true }; // child_finished ack
      const parsed = fanoutArgsSchema.safeParse(lastUserJson(wake.canonicalContext));
      if (!parsed.success) {
        await emitAssistantText(wake, `fanout-parent: invalid spawn args — ${parsed.error.message}`);
        return { handled: true, outcome: "error" };
      }
      const { tenant } = parseEntityUrl(wake.entityId);
      const childType = parsed.data.childType ?? CONFORMANCE_TYPES.fanoutChild;
      for (let i = 0; i < parsed.data.n; i++) {
        // Deterministic child ids (stable across retry attempts of this wake;
        // a re-spawn on the same key is an idempotent reattach, addressing §3.3).
        const childId = sanitizeInstanceId(wake.runId, `c${i}`);
        await wake.spawn({ childRef: entityUrl(tenant, childType, childId) });
      }
      return { handled: true };
    },
  });
}

/** `conformance-fanout-child` — finishes immediately so the parent gets `child_finished`. */
export function fanoutChildAgent(): AgentDefinition {
  return defineAgent({
    type: CONFORMANCE_TYPES.fanoutChild,
    state: emptyState,
    harness: onWakeOnlyHarness(),
    onWake: (): OnWakeOutcome => ({ handled: true }),
  });
}

const longExecBodySchema = z.object({
  command: z.string().min(1),
  /**
   * Optional per-request exec timeout (0002:T4.3, additive). Without it a
   * chaos-killed executor only surfaces the host-unresponsive backstop after
   * the workspace DEFAULT exec timeout (10 min + grace) — far outside any test
   * window. Clamped here to ≤ 1 h; the workspace object clamps again anyway.
   */
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});

/**
 * `conformance-long-exec` — workspace-exec-durability: runs the sent
 * `{command}` to completion through the CONCRETE ingress workspace client
 * (the long-exec awakeable protocol, 0001:T4.1). The ingress POST rides an
 * idempotency key derived from this wake's runId, so an agent-loop restart
 * mid-exec re-attaches to the SAME workspace invocation instead of
 * re-executing — the exec lives in the executor plane (0001:D4), which is
 * precisely the invariant the scenario asserts.
 */
export function longExecAgent(deps: ConformanceAgentDeps): AgentDefinition {
  return defineAgent({
    type: CONFORMANCE_TYPES.longExec,
    state: emptyState,
    harness: onWakeOnlyHarness(),
    onWake: async (wake): Promise<OnWakeOutcome> => {
      if (wake.wakeSource === "spawn") return { handled: true };
      const parsed = longExecBodySchema.safeParse(lastUserJson(wake.canonicalContext));
      if (!parsed.success) {
        await emitAssistantText(wake, "long-exec: send { command: string } to run a workspace exec");
        return { handled: true, outcome: "error" };
      }
      if (!deps.workspaceExec) {
        await emitAssistantText(wake, "long-exec: no workspace client wired in this deployment");
        return { handled: true, outcome: "error" };
      }
      const client = deps.workspaceExec({
        entityUrl: wake.entityId,
        runId: wake.runId,
        ...(wake.workspaceRef !== undefined && { workspaceRef: wake.workspaceRef }),
      });
      // Journal the RESULT; the ingress call inside carries the derived
      // idempotency key, so a retried step re-attaches, never re-executes.
      // `wake.signal` (0002:T4.2) forwards a live interrupt into the exec as
      // 0002:T3.1's abort→kill — the wake winds down with a killed outcome
      // and the loop records control(interrupt) + run_finished(interrupted).
      // Per-request body timeout wins over the deployment-level default.
      const timeoutMs = parsed.data.timeoutMs ?? deps.execTimeoutMs;
      const result = await wake.ctx.run("long-exec", () =>
        client.exec(parsed.data.command, {
          ...(timeoutMs !== undefined && { timeoutMs }),
          ...(wake.signal !== undefined && { signal: wake.signal }),
        }),
      );
      await emitAssistantText(
        wake,
        `exec finished (exit ${result.exitCode})` + (result.tail ? `\n${result.tail}` : ""),
      );
      return { handled: true, ...(result.exitCode !== 0 && { outcome: "error" as const }) };
    },
  });
}

/** All four conformance agents, wired with the deployment's deps. */
export function conformanceAgents(deps: ConformanceAgentDeps = {}): AgentDefinition[] {
  return [echoAgent(), fanoutParentAgent(), fanoutChildAgent(), longExecAgent(deps)];
}
