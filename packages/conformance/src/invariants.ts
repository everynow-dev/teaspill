/**
 * Reusable invariant checks (T6.3) — the assertion primitives every scenario,
 * the live e2e, and T9.1's chaos suite share.
 *
 * All functions are PURE, operate on canonical `TimelineEvent[]`, and return a
 * structured `InvariantResult` (never throw). They lean on the frozen schema
 * helpers (`checkSeqContiguity`, `checkTimelineInvariants`) so the kit stays in
 * lockstep with the A1/A5 event contract instead of re-encoding it.
 */

import {
  checkSeqContiguity,
  checkTimelineInvariants,
  type TimelineEvent,
} from "@teaspill/schema";
import type { InvariantResult } from "./types.js";

const ok = (facts?: Record<string, unknown>): InvariantResult => ({
  ok: true,
  violations: [],
  ...(facts !== undefined && { facts }),
});
const fail = (violations: string[], facts?: Record<string, unknown>): InvariantResult => ({
  ok: false,
  violations,
  ...(facts !== undefined && { facts }),
});

/**
 * A1 — the per-entity `seq` is 0-based (or `expectedFirstSeq`-based) and
 * gapless. This is the exactly-once/no-loss backbone: a gap means a projected
 * event was lost or skipped. Deduplication is the caller's job (feed a
 * seq-deduped array when the transport can readmit duplicates — see A6#2).
 */
export function assertSeqGapless(
  events: readonly Pick<TimelineEvent, "seq">[],
  opts: { expectedFirstSeq?: number } = {},
): InvariantResult {
  const res = checkSeqContiguity(events, opts);
  if (res.ok) return ok({ count: events.length });
  const at = res.violationAt ?? -1;
  return fail([
    `seq is not gapless: expected ${res.expectedSeq} at index ${at}, ` +
      `got ${at >= 0 ? events[at]?.seq : "(unknown)"}`,
  ]);
}

/**
 * A1 + D3 exactly-once at the projection layer: every `seq` appears exactly
 * once (no duplicate records survived to the reader) AND the sequence is
 * gapless. Use on a reader's view of the stream AFTER seq-dedup is expected to
 * have removed A6#2 duplicate readmissions — here we assert no duplicate seq
 * remains and no gap exists.
 */
export function assertExactlyOnceGapless(
  events: readonly TimelineEvent[],
  opts: { expectedFirstSeq?: number } = {},
): InvariantResult {
  const seen = new Map<number, number>();
  for (const e of events) seen.set(e.seq, (seen.get(e.seq) ?? 0) + 1);
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  const violations: string[] = [];
  if (dups.length > 0) violations.push(`duplicate seq(s) present: ${dups.join(", ")}`);
  const gapless = checkSeqContiguity(events, opts);
  if (!gapless.ok) {
    violations.push(
      `seq not gapless: expected ${gapless.expectedSeq} at index ${gapless.violationAt}`,
    );
  }
  return violations.length === 0
    ? ok({ count: events.length })
    : fail(violations, { duplicateSeqs: dups });
}

/**
 * A5 structural invariants: a full timeline (seq 0) starts with
 * `entity_spawned` (and it appears nowhere else), and every `summarization`
 * replaces strictly-earlier seq. Wraps `checkTimelineInvariants`.
 */
export function assertStructural(events: readonly TimelineEvent[]): InvariantResult {
  const violations = checkTimelineInvariants(events);
  return violations.length === 0 ? ok() : fail(violations);
}

/**
 * spawn→respond (D2): the subject produced at least one assistant `message`
 * and a successful `run_finished`. When `replyIncludes` is given, some
 * assistant message's text must contain it.
 */
export function assertResponded(
  events: readonly TimelineEvent[],
  opts: { replyIncludes?: string } = {},
): InvariantResult {
  const violations: string[] = [];
  const assistantMsgs = events.filter(
    (e): e is Extract<TimelineEvent, { type: "message" }> =>
      e.type === "message" && e.payload.role === "assistant",
  );
  if (assistantMsgs.length === 0) violations.push("no assistant `message` event on the timeline");

  const finishes = events.filter(
    (e): e is Extract<TimelineEvent, { type: "run_finished" }> => e.type === "run_finished",
  );
  if (finishes.length === 0) violations.push("no `run_finished` event on the timeline");
  else if (!finishes.some((f) => f.payload.outcome === "success")) {
    violations.push(
      `no successful run: outcomes were [${finishes.map((f) => f.payload.outcome).join(", ")}]`,
    );
  }

  if (opts.replyIncludes !== undefined) {
    const text = assistantMsgs
      .flatMap((m) => m.payload.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text.includes(opts.replyIncludes)) {
      violations.push(
        `assistant reply does not include ${JSON.stringify(opts.replyIncludes)}`,
      );
    }
  }
  return violations.length === 0
    ? ok({ assistantMessages: assistantMsgs.length, runsFinished: finishes.length })
    : fail(violations);
}

/**
 * Parallel fan-out (THE upstream regression, D2): the parent received a
 * `child_finished` for EVERY expected child — none dropped — and no phantom
 * extras. This is the exact dropped-parent-wake bug class: N children spawned
 * in one wake must yield N `child_finished` deliveries.
 */
export function assertAllChildFinished(
  events: readonly TimelineEvent[],
  childIds: readonly string[],
): InvariantResult {
  const finishedIds = events
    .filter(
      (e): e is Extract<TimelineEvent, { type: "child_finished" }> => e.type === "child_finished",
    )
    .map((e) => e.payload.childId);
  const finishedSet = new Set(finishedIds);
  const expectedSet = new Set(childIds);

  const missing = childIds.filter((id) => !finishedSet.has(id));
  const unexpected = finishedIds.filter((id) => !expectedSet.has(id));
  const duplicates = finishedIds.filter((id, i) => finishedIds.indexOf(id) !== i);

  const violations: string[] = [];
  if (missing.length > 0)
    violations.push(`missing child_finished for ${missing.length}/${childIds.length}: ${missing.join(", ")}`);
  if (unexpected.length > 0) violations.push(`unexpected child_finished: ${unexpected.join(", ")}`);
  if (duplicates.length > 0)
    violations.push(`duplicate child_finished (double-delivered): ${[...new Set(duplicates)].join(", ")}`);

  return violations.length === 0
    ? ok({ expected: childIds.length, delivered: finishedSet.size })
    : fail(violations, { expected: childIds.length, delivered: finishedSet.size, missing });
}

/** Count `child_spawned` events (the parent's record of a fan-out). */
export function countChildSpawned(events: readonly TimelineEvent[]): number {
  return events.filter((e) => e.type === "child_spawned").length;
}
