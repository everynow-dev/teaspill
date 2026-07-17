/**
 * Agent virtual object — seam interfaces the later coordination tasks
 * implement, plus working stub implementations so T2.1 is testable end to
 * end today (T2.1).
 *
 * Two seams are DEFINED here and STUBBED here; their real implementations
 * are separate tasks and must satisfy these exact interfaces:
 *
 * - `ProjectionOutbox` → **T2.2** (D3 exactly-once projection). The seam is
 *   the ONLY place canonical seq is allocated (A1) and the only writer of
 *   the timeline stream.
 * - `AgentNotifier` → **T2.3** (messaging/spawn/pub-sub). Fire-and-forget
 *   durable sends: subscriber notify and child→parent `child_finished`.
 *   T2.3 adds debounce (delayed send + dirty flag) and dead-letter behavior
 *   (an `error` event on the SENDER's timeline — never silent).
 *
 * The stub `Harness` stands in for Phase 3 (`@teaspill/harness-native`
 * T3.2 / `@teaspill/harness-casdk` T7.x); the agent object only ever talks
 * to the frozen `Harness` interface (D5, T3.1).
 */

import type {
  ContentBlock,
  JsonValue,
  RunUsage,
  TimelineEvent,
  TimelineEventInit,
} from "@teaspill/schema";
import { finalizeEvent } from "@teaspill/schema";
import type {
  EmitDelta,
  Harness,
  HarnessRunInput,
  HarnessRunResult,
  SteerSource,
} from "@teaspill/harness-native";
import { createSafeDeltaEmitter } from "@teaspill/harness-native";
import type { AgentRuntimeCtx, EntityStatus } from "./agent-runtime.js";
import { AGENT_KV } from "./agent-runtime.js";

// ===========================================================================
// Projection outbox seam (T2.2 contract — D3/A1)
// ===========================================================================

export interface OutboxFlushResult {
  /** Events newly confirmed onto the stream by this flush (0 when the outbox was empty). */
  appended: number;
  /** Seq of the last event confirmed on the stream, or null when nothing has ever been appended. */
  headSeq: number | null;
}

/**
 * The projection-outbox seam (D3). T2.1 calls it; **T2.2 implements it for
 * real** (durable-streams idempotent producer, catalog `head_seq` upsert);
 * `InMemoryProjectionOutbox` below is the stub that keeps T2.1 testable.
 *
 * ## Contract (what the real T2.2 implementation must honor)
 *
 * - **`stage` is the ONLY seq allocator in the system (A1).** It reads the
 *   K/V `seq` counter (next unallocated, 0-based), finalizes each
 *   `TimelineEventInit` with consecutive seqs via `finalizeEvent`, advances
 *   the counter, and appends the finalized events to the K/V pending outbox
 *   — all plain K/V writes on the exclusive handler's context, so the seq
 *   advance commits atomically with the invocation (single-writer, D3).
 *   `stage` performs NO I/O and MUST NOT touch the stream.
 * - **`flush` drains the pending outbox to the timeline stream** through the
 *   durable-streams idempotent producer (`Producer-Id` = entity url,
 *   `Producer-Seq` = seq, addressing §7), inside `ctx.run` step(s). Replay
 *   MUST proceed IN ORDER from the first unconfirmed entry (C4 rejects
 *   out-of-order producer seqs after a gap); duplicates (seq <= stream tail)
 *   are idempotent no-ops. Entries are trimmed from K/V only after confirmed
 *   append, and catalog `head_seq`/status are upserted alongside (via
 *   `ctx.run`, D1). A failed flush leaves the outbox intact — the next
 *   invocation's opening flush retries it (D3 "retried on next invocation").
 * - **Bounded steps (R4/A4).** Callers chunk: they interleave `stage` and
 *   `flush` over bounded slices (`commitEventsChunked`) so no journal entry
 *   — the K/V outbox value included — approaches the ~1 MiB budget. The
 *   implementation may additionally split one flush across multiple
 *   `ctx.run` steps (e.g. one append batch per step).
 * - Both methods are only ever called from the entity's own exclusive
 *   handlers (single-writer); they need no internal locking.
 */
export interface ProjectionOutbox {
  stage(
    ctx: AgentRuntimeCtx,
    entityId: string,
    events: readonly TimelineEventInit[],
  ): Promise<TimelineEvent[]>;
  flush(ctx: AgentRuntimeCtx, entityId: string): Promise<OutboxFlushResult>;
}

/** Default number of events staged+flushed per bounded chunk (R4). */
export const DEFAULT_OUTBOX_CHUNK_SIZE = 16;

/**
 * Commit events through the outbox seam in bounded chunks (R4/A4): for each
 * slice of at most `chunkSize` events, allocate seq + stage (K/V), then
 * flush (journaled I/O). A harness run that produced a very large event
 * array therefore never creates a single oversized journal entry or K/V
 * value — the confirmed prefix survives a crash (idempotent producer makes
 * the retried suffix exact), and each step stays well under the ~1 MiB
 * journal budget. Returns all finalized events, in order.
 */
export async function commitEventsChunked(
  ctx: AgentRuntimeCtx,
  outbox: ProjectionOutbox,
  entityId: string,
  events: readonly TimelineEventInit[],
  chunkSize: number = DEFAULT_OUTBOX_CHUNK_SIZE,
): Promise<TimelineEvent[]> {
  if (chunkSize < 1) throw new Error(`commitEventsChunked: chunkSize must be >= 1`);
  const finalized: TimelineEvent[] = [];
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    finalized.push(...(await outbox.stage(ctx, entityId, chunk)));
    await outbox.flush(ctx, entityId);
  }
  return finalized;
}

/**
 * STUB `ProjectionOutbox` (T2.1 tests; replaced by T2.2). Implements the full
 * contract shape against an in-memory "stream" per entity, INCLUDING the
 * durable-streams producer rules (C4): an append with seq <= tail is a
 * duplicate no-op; an append leaving a gap throws. That makes the stub a
 * live assertion of the A1 invariant in every test that runs through it.
 */
export class InMemoryProjectionOutbox implements ProjectionOutbox {
  /** entityId → confirmed stream (what the durable stream would contain). */
  readonly streams = new Map<string, TimelineEvent[]>();
  stageCalls = 0;
  flushCalls = 0;

  async stage(
    ctx: AgentRuntimeCtx,
    entityId: string,
    events: readonly TimelineEventInit[],
  ): Promise<TimelineEvent[]> {
    this.stageCalls += 1;
    if (events.length === 0) return [];
    const nextSeq = (await ctx.get<number>(AGENT_KV.seq)) ?? 0;
    const finalized = events.map((init, i) =>
      finalizeEvent(init, { entityId, seq: nextSeq + i }),
    );
    // Atomic with the invocation: counter advance + pending append are plain
    // K/V writes on the exclusive handler (single-writer, D3).
    ctx.set(AGENT_KV.seq, nextSeq + events.length);
    const pending = (await ctx.get<TimelineEvent[]>(AGENT_KV.outbox)) ?? [];
    ctx.set(AGENT_KV.outbox, [...pending, ...finalized]);
    return finalized;
  }

  async flush(ctx: AgentRuntimeCtx, entityId: string): Promise<OutboxFlushResult> {
    this.flushCalls += 1;
    const pending = (await ctx.get<TimelineEvent[]>(AGENT_KV.outbox)) ?? [];
    const tailSeq = (): number => {
      const stream = this.streams.get(entityId);
      return stream && stream.length > 0 ? stream[stream.length - 1]!.seq : -1;
    };
    if (pending.length === 0) {
      const tail = tailSeq();
      return { appended: 0, headSeq: tail < 0 ? null : tail };
    }
    // The real impl does the network append inside ctx.run steps; mirror that
    // so replay/journal semantics stay in the same shape.
    const appended = await ctx.run("outbox-flush", () => {
      const stream = this.streams.get(entityId) ?? [];
      let count = 0;
      for (const ev of pending) {
        const tail = stream.length > 0 ? stream[stream.length - 1]!.seq : -1;
        if (ev.seq <= tail) continue; // idempotent duplicate (C4) — no-op
        if (ev.seq !== tail + 1) {
          throw new Error(
            `InMemoryProjectionOutbox: producer seq gap for ${entityId} — expected ${tail + 1}, got ${ev.seq}`,
          );
        }
        stream.push(ev);
        count += 1;
      }
      this.streams.set(entityId, stream);
      return count;
    });
    // Confirm-and-trim (D3): only after the append step committed.
    ctx.set(AGENT_KV.outbox, []);
    return { appended, headSeq: tailSeq() };
  }

  /** Test helper: the confirmed stream for an entity (empty when none). */
  timeline(entityId: string): TimelineEvent[] {
    return this.streams.get(entityId) ?? [];
  }
}

// ===========================================================================
// Notify seam (T2.3 contract — D2 spawn/messaging/pub-sub)
// ===========================================================================

export interface SubscriberNotification {
  /** The entity that changed. */
  entityId: string;
  /** Its head seq after the change (subscribers can cheaply diff/GET from here). */
  headSeq: number | null;
  status: EntityStatus;
}

export interface ChildFinishedNotification {
  /** The finished child's entity url. */
  childId: string;
  outcome: "success" | "error" | "interrupted" | "archived";
  /** Structured result payload, when the child produced one (T3.3 `finish` tool, later). */
  result?: JsonValue;
}

/** A plain inter-agent message payload, as delivered to the target's `message` wake. */
export interface AgentSendPayload {
  content: readonly ContentBlock[];
  /** Sender entity url (rendered as `message.from` on the target). */
  from?: string;
  /** Wake-source override the target should record (default `message`). */
  source?: "message" | "system";
}

/**
 * The messaging/notify seam (D2). T2.1 defined it; **T2.3 (messaging.ts)
 * implements it for real**. All three methods are FIRE-AND-FORGET durable
 * one-way sends (`genericSend`, the SPIKE-verified pattern) — they must never
 * block or fail the wake.
 *
 * The higher-level T2.3 concerns are built AROUND this primitive, in
 * `messaging.ts`, because they need state the fire-and-forget seam cannot
 * carry: debounce for subscriber notifies (delayed self-send + K/V dirty flag
 * + generation guard, `scheduleSubscriberNotify`/`handleSubscriberNotifyTick`),
 * dead-letter (a send to a nonexistent/archived entity stages an `error`
 * event on the SENDER's timeline — `sendToAgent`/`notifyParentOrDeadLetter`),
 * parent→child spawn (`spawnChild`), and the gather-N accumulator. The fan-out
 * case — a parent spawning N children receives N `child_finished` messages as
 * N separate exclusive invocations — is delivered through `notifyParent` and
 * is a permanent regression test (PLAN T2.3 anticipate; messaging.test.ts).
 */
export interface AgentNotifier {
  notifySubscribers(
    ctx: AgentRuntimeCtx,
    subscribers: readonly string[],
    note: SubscriberNotification,
  ): void;
  notifyParent(ctx: AgentRuntimeCtx, parentRef: string, note: ChildFinishedNotification): void;
  /** One-way plain `message` send to an arbitrary agent (the `send` verb, T2.3). */
  send(ctx: AgentRuntimeCtx, targetRef: string, payload: AgentSendPayload): void;
}

/**
 * Minimal entity-url parser, duplicated from docs/addressing.md §9 until the
 * addressing helpers land in `@teaspill/schema` (they are specified there as
 * a follow-up drop-in). Returns null on non-canonical urls.
 */
export function parseEntityUrlLite(
  url: string,
): { tenant: string; type: string; id: string } | null {
  const m = /^\/t\/([a-z0-9][a-z0-9_-]*)\/a\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/.exec(
    url,
  );
  return m ? { tenant: m[1]!, type: m[2]!, id: m[3]! } : null;
}

/**
 * The Restate `{ service, key }` target for an agent entity url: service
 * `agent.<type>`, key `<id>` (A3, docs/addressing.md §6). Throws on a
 * non-canonical url (callers that want dead-letter behavior must check first).
 */
export function agentTargetOf(entityUrl: string): { service: string; key: string } {
  const parsed = parseEntityUrlLite(entityUrl);
  if (!parsed) throw new Error(`not a canonical entity url: ${JSON.stringify(entityUrl)}`);
  return { service: `agent.${parsed.type}`, key: parsed.id };
}

/**
 * The real `AgentNotifier` (T2.3): every method is a fire-and-forget one-way
 * durable send to the target agent object's `message` handler, using the
 * addressing rule service `agent.<type>` / key `<id>` (A3). Each carries a
 * typed `AgentMessageInput` variant delivered as an ordinary message wake.
 *
 * Debounce and dead-letter are deliberately NOT here — they live in
 * `messaging.ts`, layered on top of this primitive (see the interface doc).
 */
export function createAgentNotifier(): AgentNotifier {
  return {
    notifySubscribers(ctx, subscribers, note): void {
      for (const sub of subscribers) {
        const target = agentTargetOf(sub);
        ctx.genericSend({
          service: target.service,
          method: "message",
          key: target.key,
          parameter: {
            kind: "subscription_update",
            entityId: note.entityId,
            headSeq: note.headSeq,
            status: note.status,
          },
        });
      }
    },
    notifyParent(ctx, parentRef, note): void {
      const target = agentTargetOf(parentRef);
      ctx.genericSend({
        service: target.service,
        method: "message",
        key: target.key,
        parameter: {
          kind: "child_finished",
          childId: note.childId,
          outcome: note.outcome,
          ...(note.result !== undefined && { result: note.result }),
        },
      });
    },
    send(ctx, targetRef, payload): void {
      const target = agentTargetOf(targetRef);
      ctx.genericSend({
        service: target.service,
        method: "message",
        key: target.key,
        parameter: {
          kind: "message",
          content: payload.content,
          ...(payload.from !== undefined && { from: payload.from }),
          ...(payload.source !== undefined && { source: payload.source }),
        },
      });
    },
  };
}

/**
 * @deprecated Use {@link createAgentNotifier}. Retained as an alias for the
 * T2.1 call sites and tests that referenced the pre-T2.3 stub name.
 */
export const createSendNotifier = createAgentNotifier;

// ===========================================================================
// Stub harness (Phase 3 stand-in) + default steer/delta plumbing
// ===========================================================================

/**
 * STUB `Harness` (D5/T3.1 interface; real implementations are T3.2/T7.x).
 * Produces a deterministic-per-runId assistant message (ids derive from
 * `runId`, which is stable across Restate retries) plus fixed usage, or
 * whatever `opts.produce` returns. Honors `input.signal` the way the frozen
 * contract requires of long-running harnesses.
 */
export function createStubHarness(
  opts: {
    produce?: (input: HarnessRunInput) => TimelineEventInit[] | Promise<TimelineEventInit[]>;
    usage?: RunUsage;
  } = {},
): Harness {
  return {
    kind: "stub",
    async run(input: HarnessRunInput): Promise<HarnessRunResult> {
      if (input.signal.aborted) {
        throw new Error("stub harness: aborted before start");
      }
      const events = opts.produce
        ? await opts.produce(input)
        : ([
            {
              type: "message",
              ts: new Date().toISOString(), // inside ctx.run — clock reads are legal here (D2)
              payload: {
                id: `msg-${input.runId}-0`,
                runId: input.runId,
                role: "assistant",
                content: [{ type: "text", text: `stub response to run ${input.runId}` }],
              },
            },
          ] satisfies TimelineEventInit[]);
      return {
        events: [...events],
        stateDelta: {},
        usage: opts.usage ?? { inputTokens: 3, outputTokens: 5 },
      };
    },
  };
}

/** No-op steer source until the steerbox lands (T2.6): nothing is ever queued. */
export const emptySteerSource: SteerSource = {
  drain: async () => [],
};

/** No-op delta emitter honoring the fire-and-forget invariant (real sink is platform wiring, T5.1). */
export const noopEmitDelta: EmitDelta = createSafeDeltaEmitter(() => undefined);
