/**
 * Parallel fan-out — the PERMANENT REGRESSION for the upstream dropped-parent-
 * wake bug (parallel sub-agent spawn dropped `child_finished` deliveries).
 *
 * This runner drives the REAL coordination messaging primitives (`spawnChild`,
 * the projection outbox, `accumulateChildResult`) with no live stack: a parent
 * spawns N children in ONE wake, then each `child_finished` arrives on its OWN
 * separate invocation (exactly the 0001:D2 model), and every one must be delivered
 * to the parent's timeline and gathered. Exported so both the CI test and
 * 0001:T9.1's chaos suite reuse it.
 */

import {
  AGENT_KV,
  InMemoryProjectionOutbox,
  accumulateChildResult,
  createGather,
  spawnChild,
  type AgentRuntimeCtx,
} from "@teaspill/coordination";
import type { TimelineEvent, TimelineEventInit } from "@teaspill/schema";
import { MemoryWorld } from "./support/memory-ctx.js";

const NOW = "2026-07-17T00:00:00.000Z";
const GATHER_SLOT = "gather:fanout";

export interface FanoutResult {
  parentId: string;
  childIds: string[];
  /** The parent's full projected timeline (entity_spawned + child_spawned×N + child_finished×N). */
  parentTimeline: TimelineEvent[];
  /** Invocation index (0-based) at which the gather completed, or -1 if never. */
  completedAtChild: number;
  /** The one-way `spawn` sends the parent issued. */
  spawnSendKeys: string[];
  gatherChildIds: string[];
}

async function seedSpawned(
  outbox: InMemoryProjectionOutbox,
  ctx: AgentRuntimeCtx,
  entityId: string,
): Promise<void> {
  await outbox.stage(ctx, entityId, [
    { type: "entity_spawned", ts: NOW, payload: { entityType: "conformance-parent", parentId: null } },
  ]);
  await outbox.flush(ctx, entityId);
  ctx.set(AGENT_KV.status, "idle");
}

/**
 * Run the offline fan-out. `redeliverChild` (an index) re-delivers that child's
 * `child_finished` a second time to prove the gather is idempotent-by-childId
 * (at-least-once redelivery must never double-count).
 */
export async function runParallelFanout(opts: {
  n: number;
  tenant?: string;
  redeliverChild?: number;
}): Promise<FanoutResult> {
  const tenant = opts.tenant ?? "default";
  const parentId = `/t/${tenant}/a/conformance-parent/p-1`;
  const childIds = Array.from(
    { length: opts.n },
    (_, i) => `/t/${tenant}/a/conformance-child/c-${i}`,
  );
  const world = new MemoryWorld("p-1");
  const outbox = new InMemoryProjectionOutbox();

  // --- ONE parent wake: spawn N children + open the gather slot.
  const parentWake = world.ctx({ invocationId: "inv-parent" });
  await seedSpawned(outbox, parentWake, parentId);
  parentWake.set(GATHER_SLOT, createGather(opts.n));

  const childSpawned: TimelineEventInit[] = [];
  for (const childRef of childIds) {
    childSpawned.push(
      await spawnChild(parentWake, {
        childRef,
        parentRef: parentId,
        args: { i: childRef },
        runId: "run-parent",
      }),
    );
  }
  await outbox.stage(parentWake, parentId, childSpawned);
  await outbox.flush(parentWake, parentId);

  const spawnSendKeys = world.sent
    .filter((s) => s.method === "spawn")
    .map((s) => s.key ?? "")
    .sort();

  // --- N SEPARATE invocations: each child_finished lands on its own wake.
  //     This is the exact bug class — none may be dropped or collide.
  // Offline stages `child_finished` directly through the outbox (the real
  // `AgentNotifier` back-send is exercised on the live path).
  let completedAtChild = -1;
  const deliver = async (i: number, invSuffix: string, commitEvent: boolean): Promise<void> => {
    const wake = world.ctx({ invocationId: `inv-cf-${i}-${invSuffix}` });
    // A redelivered wake is deduped at the message handler, so it does NOT
    // re-commit the timeline event — but the gather MUST stay idempotent.
    if (commitEvent) {
      await outbox.stage(wake, parentId, [
        {
          type: "child_finished",
          ts: NOW,
          payload: { childId: childIds[i]!, outcome: "success", result: { i } },
        },
      ]);
      await outbox.flush(wake, parentId);
    }
    const acc = await accumulateChildResult(wake, GATHER_SLOT, {
      childId: childIds[i]!,
      outcome: "success",
      result: { i },
    });
    if (acc.complete && completedAtChild < 0) completedAtChild = i;
  };

  for (let i = 0; i < opts.n; i++) {
    await deliver(i, "a", true);
    if (opts.redeliverChild === i) await deliver(i, "redelivery", false);
  }

  const gather = world.kv<{ results: { childId: string }[] }>(GATHER_SLOT);
  return {
    parentId,
    childIds,
    parentTimeline: outbox.timeline(parentId),
    completedAtChild,
    spawnSendKeys,
    gatherChildIds: (gather?.results ?? []).map((r) => r.childId).sort(),
  };
}
