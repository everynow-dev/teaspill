/**
 * Harness interface (0001:T3.1) — the seam both harnesses plug into (0001:D5).
 *
 * STATUS: PROPOSED alongside the 0001:T0.1 schema — freezes together at gate 0001:G3.
 *
 * This module is types + contract only. It lives in `@teaspill/harness-native`
 * as the interface's home package, and is deliberately DEPENDENCY-LIGHT
 * (only `@teaspill/schema` and type-only zod) so `@teaspill/harness-casdk`
 * and `@teaspill/agents-sdk` can import it without dragging in pi-ai, the
 * Restate SDK, or the Claude Agent SDK.
 *
 * ## The contract in one paragraph
 *
 * The agent virtual object (0001:T2.1), inside its handler, calls
 * `harness.run({ canonicalContext, wakeMessage, tools, steerSource, signal,
 * emitDelta })` and gets back `{ events, stateDelta, usage }`. The harness
 * owns the LLM loop (natively, or by delegating to the CASDK). It emits
 * finalized canonical events as `TimelineEventInit` — WITHOUT `seq`: seq is
 * allocated exclusively by the entity handler's outbox at commit time
 * (0001:D3/0001:A1), which is what keeps the per-entity sequence 0-based and gapless.
 * Ephemeral token deltas go out-of-band through `emitDelta`. Steering
 * messages are drained from `steerSource` at the harness's natural
 * checkpoints. `signal` aborts the run (the `interrupt` verb, 0001:T2.5).
 *
 * ## Load-bearing invariants
 *
 * 1. **Exactly-once tool effects.** Every side-effecting tool invocation goes
 *    through Restate ingress with the idempotency key
 *    `(entityUrl, runId, toolUseId)` — see `toolIdempotencyKey` and
 *    `ToolContext`. This holds for BOTH harnesses and is what makes tool
 *    effects exactly-once under ANY retry granularity: whether Restate
 *    retries a single `ctx.run` step (native harness) or a whole run (CASDK
 *    harness), the re-executed tool call carries the same key and the ingress
 *    dedupes it.
 * 2. **`emitDelta` never blocks or fails the run.** It is synchronous
 *    fire-and-forget: implementations MUST NOT return work the harness would
 *    await, MUST NOT throw, and when the streams server is down MUST drop
 *    deltas silently — the run proceeds and the finalized events still land
 *    via the outbox. (`createSafeDeltaEmitter` is the reference wrapper;
 *    the invariant is tested in interface.test.ts.)
 * 3. **Returned events are the un-committed tail.** Everything in
 *    `HarnessRunResult.events` will be committed by the caller, in order,
 *    after `run` resolves. A step-durable harness that commits events
 *    incrementally through `commitEvents` (see below) must NOT repeat those
 *    events in the result.
 * 4. **Resume superset rule (0001:D5).** On any retry/resume, the context the
 *    harness rebuilds from `canonicalContext` contains everything that was
 *    finalized — the agent's memory is always a superset of what the user
 *    saw, minus at most a trailing partial message.
 */

import type { ZodType } from "zod";
import type {
  ContentBlock,
  DeltaInit,
  JsonValue,
  RunUsage,
  TimelineEvent,
  TimelineEventInit,
  WakeSource,
} from "@teaspill/schema";

// ===========================================================================
// Tool idempotency (load-bearing clause)
// ===========================================================================

/**
 * The exactly-once key for side-effecting tool invocations:
 * `(entityUrl, runId, toolUseId)`, rendered as a single ingress idempotency
 * key. EVERY side-effecting tool invocation — spawn, send, workspace exec/fs,
 * any custom platform call — MUST go through Restate ingress with this key.
 * Never invoke side effects directly from tool code.
 *
 * Why it works under any retry granularity: `toolUseId` is minted by the
 * model/provider inside the run and is stable across replays of the same
 * logical tool call (the native harness journals it; the CASDK durable
 * session persists it), so a retried step or a whole-run retry re-issues the
 * SAME key and Restate's ingress dedup makes the effect happen once.
 *
 * The rendered form uses U+001F (the ASCII unit separator) as the joiner — it cannot
 * appear in entity urls (charset `[a-z0-9_-]` + `/`), runIds, or provider
 * tool-use ids, so the mapping is injective without escaping.
 */
export function toolIdempotencyKey(entityUrl: string, runId: string, toolUseId: string): string {
  if (!entityUrl || !runId || !toolUseId) {
    throw new Error(
      `toolIdempotencyKey: all of entityUrl/runId/toolUseId are required ` +
        `(got ${JSON.stringify({ entityUrl, runId, toolUseId })})`,
    );
  }
  const SEP = "\u001f"; // ASCII unit separator
  for (const [name, v] of Object.entries({ entityUrl, runId, toolUseId })) {
    if (v.includes(SEP)) {
      throw new Error(`toolIdempotencyKey: ${name} contains the separator`);
    }
  }
  return `${entityUrl}${SEP}${runId}${SEP}${toolUseId}`;
}

// ===========================================================================
// Tool interface
// ===========================================================================

/** What a tool's `execute` returns — mirrors `tool_result.payload`. */
export interface ToolExecutionResult {
  content: ContentBlock[];
  /** Structured detail for rich renderers (diff, exitCode, streamRef, …). */
  detail?: JsonValue;
  isError?: boolean;
}

/** Options for spawning a child entity (platform client surface; 0001:T3.3 owns semantics). */
export interface SpawnRequest {
  /** Agent type to spawn. */
  entityType: string;
  /** Caller-supplied instance id for deterministic/idempotent spawn (addressing §3.2). */
  id?: string;
  args?: JsonValue;
  /** Workspace key; defaults to a private workspace (addressing §5). */
  workspaceRef?: string;
}

export interface SendRequest {
  /** Target entity url. */
  to: string;
  content: ContentBlock[];
  /** `steer` targets a mid-run entity's steerbox; default is a message wake. */
  mode?: "message" | "steer";
}

/**
 * Platform coordination client available to tools. Implementations route
 * every call through Restate ingress carrying the ToolContext's idempotency
 * key (invariant 1) — a client instance is BOUND to one tool invocation.
 */
export interface PlatformClient {
  /** Spawn a child (one-way durable send; completion arrives later as a `child_finished` message wake). */
  spawn(req: SpawnRequest): Promise<{ entityId: string }>;
  send(req: SendRequest): Promise<void>;
  /** List this entity's children from the catalog (read-only; no idempotency needed). */
  listChildren(): Promise<Array<{ entityId: string; entityType: string; status: string }>>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Bounded exec result (0001:R4): bulk stdout goes to the workspace stream, the journal carries refs. */
export interface ExecResult {
  exitCode: number;
  /** Trailing output bytes, bounded. */
  tail: string;
  /** Stream path carrying the full stdout/stderr (addressing §4.3). */
  streamRef?: string;
}

/**
 * Workspace client available to tools (0001:T4.1 owns full semantics). Serialized
 * per workspace by construction (0001:D4). All methods are side-effecting except
 * the reads — implementations still route everything through the workspace
 * virtual object, side-effecting calls with the bound idempotency key.
 */
export interface WorkspaceClient {
  /** The workspace key this client is bound to (agent state's workspaceRef). */
  readonly workspaceRef: string;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  ls(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  stat(path: string): Promise<{ kind: "file" | "dir"; size: number; mtimeMs: number }>;
}

/**
 * Per-invocation context handed to `ToolDefinition.execute`. Constructed
 * fresh for each tool call: the clients are bound to `idempotencyKey`
 * (= `toolIdempotencyKey(entityUrl, runId, toolUseId)`), so tool authors get
 * exactly-once semantics without handling keys themselves.
 */
export interface ToolContext {
  /** Canonical entity url of the running agent. */
  entityUrl: string;
  runId: string;
  /** Provider tool-use id of THIS call — third key component. */
  toolUseId: string;
  /** The rendered ingress idempotency key for this invocation. */
  idempotencyKey: string;
  /** Aborts with the run (`interrupt` verb, watchdogs). Long tools must observe it. */
  signal: AbortSignal;
  platform: PlatformClient;
  /** Present when the agent has a workspaceRef (0001:D4). */
  workspace?: WorkspaceClient;
}

/**
 * A tool as registered with a harness. `schema` is the zod schema for
 * `input`; harnesses derive the provider-facing JSON schema from it (and the
 * CASDK harness derives the in-process MCP tool from it, 0001:T7.2).
 */
export interface ToolDefinition<Input = unknown> {
  /** Bare tool name (canonical `tool_call.payload.name`; MCP qualification is harness-internal). */
  name: string;
  /** Model-facing description — written for the model, not for humans (0001:T3.3). */
  description: string;
  schema: ZodType<Input>;
  execute(input: Input, ctx: ToolContext): Promise<ToolExecutionResult>;
}

/**
 * Existential form for heterogeneous tool lists: any concrete
 * `ToolDefinition<Input>` is assignable (`schema` is covariant in its output;
 * `execute` is method-syntax, hence bivariant). The harness — which cannot
 * know `Input` statically — MUST parse raw model input through `schema`
 * before calling `execute`; the `never` parameter makes calling it with
 * unvalidated input a type error.
 */
export interface AnyToolDefinition {
  name: string;
  description: string;
  schema: ZodType<unknown>;
  execute(input: never, ctx: ToolContext): Promise<ToolExecutionResult>;
}

// ===========================================================================
// Steering
// ===========================================================================

export interface SteerMessage {
  id: string;
  ts: string;
  content: ContentBlock[];
  /** Sender entity url, when steered by another agent. */
  from?: string;
}

/**
 * Drain interface over the `steer/<entityId>` companion object (0001:D2, 0001:T2.6).
 * Harnesses poll it at their natural checkpoints — the native harness between
 * LLM steps, the CASDK harness at tool-handler boundaries and/or a light poll
 * — and inject the drained messages into the live run as user input.
 *
 * `drain()` returns-and-clears atomically (the steerbox object is a Restate
 * virtual object; single-writer makes this exact). Empty array when nothing
 * is queued. Messages a run never drained are NOT lost: the agent drains the
 * steerbox again at the start of the next wake (0001:T2.6 race rule).
 */
export interface SteerSource {
  drain(): Promise<SteerMessage[]>;
}

// ===========================================================================
// Deltas
// ===========================================================================

/**
 * Fire-and-forget delta channel (invariant 2 — NEVER blocks, NEVER throws,
 * deltas DROP when the sink is down while the run proceeds). Deltas land on
 * the sibling `/deltas` stream (see @teaspill/schema deltas.ts framing
 * decision), reference their finalized event via `ref`, and take no seq.
 */
export type EmitDelta = (delta: DeltaInit) => void;

/**
 * Reference wrapper that makes any sink honor the emitDelta invariant:
 * synchronous exceptions are swallowed, returned promises get a no-op catch
 * (a rejecting async sink can't become an unhandled rejection), and nothing
 * is ever awaited. `onDrop` (optional) observes drops for metrics/logs.
 */
export function createSafeDeltaEmitter(
  sink: (delta: DeltaInit) => unknown,
  opts: { onDrop?: (err: unknown) => void } = {},
): EmitDelta {
  const drop = (err: unknown): void => {
    try {
      opts.onDrop?.(err);
    } catch {
      // onDrop must not be able to break the invariant either.
    }
  };
  return (delta) => {
    try {
      const out = sink(delta);
      if (
        out !== null &&
        typeof out === "object" &&
        typeof (out as PromiseLike<unknown>).then === "function"
      ) {
        void Promise.resolve(out).then(undefined, drop);
      }
    } catch (err) {
      drop(err);
    }
  };
}

// ===========================================================================
// Harness.run
// ===========================================================================

/** The wake input that triggered this run. */
export interface WakeMessage {
  source: WakeSource;
  content: ContentBlock[];
  /** Sender entity url, when applicable. */
  from?: string;
}

export interface HarnessRunInput {
  /** Canonical entity url (identity for events, idempotency keys, streams). */
  entityId: string;
  /** Unique id for this wake/run; stable across Restate retries of the same run. */
  runId: string;
  /** Restate invocation attempt, for delta/usage retry disambiguation (0001:T7.4). */
  attempt?: number;
  /**
   * The entity's bounded conversation context as canonical events, in seq
   * order (from agent K/V state, NOT read from the stream — 0001:D1). The harness
   * assembles provider messages from it (see ContextAssembler / the
   * context-assembly contract in ./context.ts).
   */
  canonicalContext: readonly TimelineEvent[];
  /** The triggering input, or null for a continuation wake (context already ends on user input). */
  wakeMessage: WakeMessage | null;
  tools: readonly AnyToolDefinition[];
  steerSource: SteerSource;
  /** Aborted by the `interrupt` verb (0001:T2.5) or platform watchdogs. */
  signal: AbortSignal;
  emitDelta: EmitDelta;
  /**
   * OPTIONAL step-boundary commit channel for step-durable harnesses (the
   * native harness commits canonical events through the outbox at each step
   * boundary, 0001:D5). When provided, the harness MAY hand off finalized events
   * mid-run; committed events MUST NOT be repeated in the returned
   * `events`. When absent, all events are returned at the end. The callee
   * (agent handler) allocates seq and writes the outbox inside its own
   * journaled steps.
   */
  commitEvents?: (events: readonly TimelineEventInit[]) => Promise<void>;
}

/**
 * Harness-owned state updates the agent handler persists to K/V alongside
 * the run's events. Deliberately narrow: entity status, context, and seq are
 * the handler's business, not the harness's.
 */
export interface HarnessStateDelta {
  /**
   * Opaque per-harness continuation state, replaced wholesale in agent K/V.
   * The CASDK harness stores `{ sessionId, seqStamp }` here (0001:D5 layer 3 —
   * trust-but-verify warm resume); the native harness typically stores
   * nothing. `null` clears; `undefined` leaves unchanged.
   */
  harness?: JsonValue | null;
  /**
   * Real cache-inclusive context size after the run's last step — seeds the
   * next run's budget accounting / summarization decision (0001:T3.2).
   */
  contextTokens?: number;
}

export interface HarnessRunResult {
  /**
   * Finalized canonical events produced by the run and not yet committed
   * (see invariant 3). The caller commits them in array order; seq is
   * allocated there (0001:A1).
   */
  events: TimelineEventInit[];
  stateDelta: HarnessStateDelta;
  /** Authoritative usage for the run — lands in `run_finished.payload.usage`. */
  usage: RunUsage;
}

/**
 * The harness abstraction (0001:D5). Implementations:
 * - `@teaspill/harness-native` (pi-ai; 0001:T3.2) — step-durable owned loop.
 * - `@teaspill/harness-casdk` (Claude Agent SDK; T7.x) — SDK-owned loop with
 *   idempotent effects, durable-session continuation, canonical truth.
 *
 * `run` rejects only on run-level failure the harness could not convert into
 * an `error` event (the caller then records the error and keeps the entity
 * consistent). An abort via `signal` resolves normally with the events
 * finalized so far and outcome `interrupted` reflected in its run_finished
 * event — interruption is a normal outcome, not an exception.
 */
export interface Harness {
  readonly kind: "native" | "casdk" | (string & {});
  run(input: HarnessRunInput): Promise<HarnessRunResult>;
}
