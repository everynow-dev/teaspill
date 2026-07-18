/**
 * Platform tools (0001:T3.3) — the coordination toolset every harness exposes to
 * the model (0001:D5). Defined once here against the FROZEN 0001:T3.1 tool interface
 * (`ToolDefinition` / `ToolContext` in ./interface.ts) so BOTH harnesses
 * consume the same registry: the pi-ai native harness (0001:T3.2) and the CASDK
 * in-process MCP server (0001:T7.2).
 *
 * ## The tools
 *
 * - `spawn_agent(type, args, …)` — spawn a child; returns its id IMMEDIATELY,
 *   never its result. The result arrives LATER as a `child_finished` message
 *   on a future wake.
 * - `send_message(to, message)` — fire-and-forget send to another agent;
 *   returns on enqueue.
 * - `list_children()` — read-only view of this agent's known children.
 * - `wait(reason?)` — returns IMMEDIATELY and yields the turn. There is no
 *   synchronous blocking anywhere in this runtime; the WAKE MODEL re-invokes
 *   the agent when a relevant message arrives.
 * - `finish(result?)` — end the turn and mark the run complete; `result` is
 *   reported to the parent (as its `child_finished`).
 * - `set_status(status)` — update the agent's short status line; non-terminal.
 *
 * ## Model ergonomics (the load-bearing part — PLAN 0001:T3.3 "Anticipate")
 *
 * The #1 model-confusion point is the async-result / wake model: "spawn
 * returns, the result arrives on a LATER wake" and "`wait` does NOT block".
 * These tools' DESCRIPTIONS are written to TEACH the model that, and the tests
 * assert on the description text so a future edit cannot silently drop the
 * teaching. PLAN budgets a tuning pass on these strings against real
 * transcripts — see WORKLOG open questions.
 *
 * ## How effects route (0001:T3.1 exactly-once contract)
 *
 * Side-effecting tools drive the client injected on `ToolContext`, which is
 * pre-BOUND to this call's idempotency key `(entityUrl, runId, toolUseId)`
 * (interface.ts invariant 1) — tool code just calls `ctx.platform.*`; the
 * client renders/attaches the key and routes through Restate ingress, so the
 * effect is exactly-once under any retry granularity. Tool authors never build
 * a key. Read-only tools (`list_children`) take no key.
 *
 * `wait` / `finish` / `set_status` are CONTROL tools: they mutate only this
 * agent's own run/status, which is the single-writer entity handler's
 * business at commit time (naturally idempotent — no cross-retry duplication
 * to guard). The frozen `ToolContext`/`PlatformClient` expose NO lifecycle
 * method and `HarnessStateDelta`/`ToolExecutionResult` expose no status field,
 * so these tools convey their effect as a machine-readable control signal in
 * the returned `tool_result.detail` (namespaced under `PLATFORM_CONTROL_KEY`).
 * The harness reads it with `readPlatformControlSignal` at the tool boundary
 * and applies it (end the loop / persist the status) when it commits the run.
 * See WORKLOG "ToolContext gap".
 */

import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "@teaspill/schema";
import type { AnyToolDefinition, ToolDefinition, ToolExecutionResult } from "./interface.js";

// ===========================================================================
// Tool names (harnesses match control tools by name; exported so 0001:T3.2/0001:T7.2
// don't hardcode strings)
// ===========================================================================

export const PLATFORM_TOOL_NAMES = {
  spawnAgent: "spawn_agent",
  sendMessage: "send_message",
  listChildren: "list_children",
  wait: "wait",
  finish: "finish",
  setStatus: "set_status",
} as const;

export type PlatformToolName = (typeof PLATFORM_TOOL_NAMES)[keyof typeof PLATFORM_TOOL_NAMES];

// ===========================================================================
// Control signal (wait / finish / set_status effect channel)
// ===========================================================================

/**
 * Where a control tool stashes its signal inside `ToolExecutionResult.detail`.
 * Namespaced so it can never collide with a tool's own structured detail.
 */
export const PLATFORM_CONTROL_KEY = "@teaspill/control" as const;

/**
 * The effect a control tool requests of the harness loop:
 * - `wait`   — end the turn, stay alive (re-woken by the wake model).
 * - `finish` — end the turn AND mark the run complete; `result` → parent.
 * - `set_status` — update the status line; NON-terminal (loop continues).
 */
export type PlatformControlSignal =
  | { kind: "wait"; reason?: string }
  | { kind: "finish"; result?: JsonValue }
  | { kind: "set_status"; status: string };

const controlSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("wait"), reason: z.string().optional() }),
  z.object({ kind: z.literal("finish"), result: jsonValueSchema.optional() }),
  z.object({ kind: z.literal("set_status"), status: z.string().min(1) }),
]);

/** True when this control signal ends the current turn (`wait` / `finish`). */
export function isTerminalControl(signal: PlatformControlSignal): boolean {
  return signal.kind === "wait" || signal.kind === "finish";
}

/**
 * Extract the control signal a `wait`/`finish`/`set_status` tool embedded in
 * its result, or `null` for an ordinary tool result. The harness (0001:T3.2/0001:T7.2)
 * calls this after every tool execution to decide whether to end the loop or
 * apply a status change. Validates the embedded payload defensively.
 */
export function readPlatformControlSignal(
  result: ToolExecutionResult,
): PlatformControlSignal | null {
  const detail = result.detail;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return null;
  const raw = (detail as { [k: string]: JsonValue })[PLATFORM_CONTROL_KEY];
  if (raw === undefined) return null;
  const parsed = controlSignalSchema.safeParse(raw);
  // The zod-inferred optionals widen to `T | undefined`; the hand-written
  // PlatformControlSignal is the same shape modulo exactOptionalPropertyTypes.
  return parsed.success ? (parsed.data as PlatformControlSignal) : null;
}

function controlResult(signal: PlatformControlSignal, text: string): ToolExecutionResult {
  return {
    content: [{ type: "text", text }],
    detail: { [PLATFORM_CONTROL_KEY]: signal as unknown as JsonValue },
  };
}

// ===========================================================================
// Zod input schemas (strict, model-facing descriptions)
// ===========================================================================

export const spawnAgentInputSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .describe("The agent type to spawn (e.g. 'researcher'). Must be a deployed agent type."),
    args: jsonValueSchema
      .optional()
      .describe("Arguments passed to the child's spawn handler, as JSON. Shape is per agent type."),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional caller-chosen instance id for a DETERMINISTIC spawn: spawning the same " +
          "(type, id) twice reattaches to the same child instead of creating a duplicate.",
      ),
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional workspace key for the child. Omit for a fresh private workspace. " +
          "A workspace is fixed at spawn time and never switched later.",
      ),
  })
  .strict();
export type SpawnAgentInput = z.infer<typeof spawnAgentInputSchema>;

export const sendMessageInputSchema = z
  .object({
    to: z
      .string()
      .min(1)
      .describe("The recipient agent's entity url (e.g. '/t/default/a/researcher/<id>')."),
    message: z.string().min(1).describe("The message text to deliver to the recipient."),
    mode: z
      .enum(["message", "steer"])
      .optional()
      .describe(
        "'message' (default) wakes the recipient as a normal turn. 'steer' injects into the " +
          "recipient's CURRENT run if it is mid-turn, otherwise degrades to a normal message.",
      ),
  })
  .strict();
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const listChildrenInputSchema = z.object({}).strict();
export type ListChildrenInput = z.infer<typeof listChildrenInputSchema>;

export const waitInputSchema = z
  .object({
    reason: z
      .string()
      .optional()
      .describe(
        "Optional note describing what you are waiting for (e.g. 'results from 3 children'). " +
          "For observability only — it does not change behavior.",
      ),
  })
  .strict();
export type WaitInput = z.infer<typeof waitInputSchema>;

export const finishInputSchema = z
  .object({
    result: jsonValueSchema
      .optional()
      .describe("Optional result reported back to whoever spawned this agent (as JSON)."),
    summary: z
      .string()
      .optional()
      .describe("Optional human-readable summary of what was accomplished."),
  })
  .strict();
export type FinishInput = z.infer<typeof finishInputSchema>;

export const setStatusInputSchema = z
  .object({
    status: z
      .string()
      .min(1)
      .max(200)
      .describe("A short human-readable status line, e.g. 'researching sources'."),
  })
  .strict();
export type SetStatusInput = z.infer<typeof setStatusInputSchema>;

// ===========================================================================
// Model-facing descriptions (the teaching — asserted on in tests)
// ===========================================================================

export const PLATFORM_TOOL_DESCRIPTIONS = {
  spawn_agent:
    "Spawn a new child agent and return IMMEDIATELY with its id/url. IMPORTANT: this does NOT " +
    "wait for the child to run or return its result. The child runs concurrently; when it " +
    "finishes, its result is delivered to you LATER as a `child_finished` message on a future " +
    "wake (a new turn) — not from this call. Do not block, poll, or busy-wait for the result: " +
    "spawn what you need, then end your turn (e.g. call `wait`) and you will be re-woken when a " +
    "child reports back. Use `list_children` to review children you have already spawned.",
  send_message:
    "Send a one-way message to another agent by its entity url. Fire-and-forget: this returns as " +
    "soon as the message is ENQUEUED for delivery — it does NOT wait for the recipient to read or " +
    "reply. If the recipient replies, that reply arrives LATER as a separate message on a future " +
    "wake, never as the return value of this call.",
  list_children:
    "List the child agents this agent has spawned, with each child's current status. Read-only, " +
    "no side effects. This reflects the catalog at call time: a child you just spawned appears " +
    "here, but its final RESULT still arrives asynchronously as a `child_finished` message on a " +
    "future wake — never read it from this list.",
  wait:
    "Yield your turn. This tool returns IMMEDIATELY — it does NOT block, sleep, or synchronously " +
    "wait for anything, because there is NO synchronous waiting in this runtime. Calling `wait` " +
    "cleanly ends the current turn and the agent goes idle; you are then AUTOMATICALLY re-woken " +
    "as a NEW turn when a relevant message arrives (for example a `child_finished` result from a " +
    "child you spawned, or a new message from a user or another agent). Call `wait` once when you " +
    "have nothing further to do right now and are expecting results or input later. Never loop or " +
    "busy-wait to 'check' for results — just call `wait` and end the turn.",
  finish:
    "Finish this agent's work. Ends the current turn and marks the run complete; the optional " +
    "`result` is reported back to whoever spawned this agent (delivered to the parent as a " +
    "`child_finished` message on its next wake). Use `finish` when the task is DONE — as opposed " +
    "to `wait`, which yields the turn while keeping the agent available for more work.",
  set_status:
    "Update this agent's short human-readable status line (shown in dashboards and observability). " +
    "Does NOT end your turn — the agent keeps running. Use it to reflect what you are currently " +
    "doing, e.g. 'researching sources' or 'waiting on 3 child results'.",
} as const satisfies Record<PlatformToolName, string>;

// ===========================================================================
// Tool definitions
// ===========================================================================

function textResult(text: string, detail?: JsonValue): ToolExecutionResult {
  return detail === undefined
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }], detail };
}

/**
 * `spawn_agent` — side-effecting. Drives `ctx.platform.spawn` (pre-bound to the
 * idempotency key) and returns the child's id SYNCHRONOUSLY. The result is NOT
 * awaited here (arrives later as `child_finished`).
 */
export function spawnAgentTool(): ToolDefinition<SpawnAgentInput> {
  return {
    name: PLATFORM_TOOL_NAMES.spawnAgent,
    description: PLATFORM_TOOL_DESCRIPTIONS.spawn_agent,
    schema: spawnAgentInputSchema,
    async execute(input, ctx): Promise<ToolExecutionResult> {
      const { entityId } = await ctx.platform.spawn({
        entityType: input.type,
        ...(input.args !== undefined && { args: input.args }),
        ...(input.id !== undefined && { id: input.id }),
        ...(input.workspace !== undefined && { workspaceRef: input.workspace }),
      });
      return textResult(
        `Spawned ${input.type} as ${entityId}. Its result will arrive later as a ` +
          `child_finished message on a future wake.`,
        { entityId, entityType: input.type },
      );
    },
  };
}

/** `send_message` — side-effecting. Drives `ctx.platform.send`; returns on enqueue. */
export function sendMessageTool(): ToolDefinition<SendMessageInput> {
  return {
    name: PLATFORM_TOOL_NAMES.sendMessage,
    description: PLATFORM_TOOL_DESCRIPTIONS.send_message,
    schema: sendMessageInputSchema,
    async execute(input, ctx): Promise<ToolExecutionResult> {
      await ctx.platform.send({
        to: input.to,
        content: [{ type: "text", text: input.message }],
        ...(input.mode !== undefined && { mode: input.mode }),
      });
      return textResult(`Message enqueued for ${input.to}.`);
    },
  };
}

/** `list_children` — read-only. No idempotency key needed (0001:T3.1). */
export function listChildrenTool(): ToolDefinition<ListChildrenInput> {
  return {
    name: PLATFORM_TOOL_NAMES.listChildren,
    description: PLATFORM_TOOL_DESCRIPTIONS.list_children,
    schema: listChildrenInputSchema,
    async execute(_input, ctx): Promise<ToolExecutionResult> {
      const children = await ctx.platform.listChildren();
      const text =
        children.length === 0
          ? "No children spawned yet."
          : children
              .map((c) => `- ${c.entityId} (${c.entityType}): ${c.status}`)
              .join("\n");
      return textResult(text, { children });
    },
  };
}

/** `wait` — control tool. Returns immediately; yields the turn (see description). */
export function waitTool(): ToolDefinition<WaitInput> {
  return {
    name: PLATFORM_TOOL_NAMES.wait,
    description: PLATFORM_TOOL_DESCRIPTIONS.wait,
    schema: waitInputSchema,
    execute(input): Promise<ToolExecutionResult> {
      const signal: PlatformControlSignal = {
        kind: "wait",
        ...(input.reason !== undefined && { reason: input.reason }),
      };
      return Promise.resolve(
        controlResult(
          signal,
          "Turn yielded. The agent is now idle and will be re-woken as a new turn when a " +
            "relevant message (e.g. child_finished) arrives.",
        ),
      );
    },
  };
}

/** `finish` — control tool. Ends the turn and marks the run complete. */
export function finishTool(): ToolDefinition<FinishInput> {
  return {
    name: PLATFORM_TOOL_NAMES.finish,
    description: PLATFORM_TOOL_DESCRIPTIONS.finish,
    schema: finishInputSchema,
    execute(input): Promise<ToolExecutionResult> {
      const signal: PlatformControlSignal = {
        kind: "finish",
        ...(input.result !== undefined && { result: input.result }),
      };
      const text = input.summary ? `Finished: ${input.summary}` : "Run finished.";
      return Promise.resolve(controlResult(signal, text));
    },
  };
}

/** `set_status` — control tool. Updates the status line; NON-terminal. */
export function setStatusTool(): ToolDefinition<SetStatusInput> {
  return {
    name: PLATFORM_TOOL_NAMES.setStatus,
    description: PLATFORM_TOOL_DESCRIPTIONS.set_status,
    schema: setStatusInputSchema,
    execute(input): Promise<ToolExecutionResult> {
      return Promise.resolve(
        controlResult({ kind: "set_status", status: input.status }, `Status set: ${input.status}`),
      );
    },
  };
}

// ===========================================================================
// Registry — the seam both harnesses consume
// ===========================================================================

export interface PlatformToolsOptions {
  /**
   * Restrict the returned set to these tool names (in this order). Omit for
   * all six. Lets a harness/agent config drop tools it does not want the model
   * to have (e.g. a leaf agent with no `spawn_agent`).
   */
  include?: readonly PlatformToolName[];
}

const ALL_TOOL_FACTORIES: Record<PlatformToolName, () => AnyToolDefinition> = {
  [PLATFORM_TOOL_NAMES.spawnAgent]: spawnAgentTool,
  [PLATFORM_TOOL_NAMES.sendMessage]: sendMessageTool,
  [PLATFORM_TOOL_NAMES.listChildren]: listChildrenTool,
  [PLATFORM_TOOL_NAMES.wait]: waitTool,
  [PLATFORM_TOOL_NAMES.finish]: finishTool,
  [PLATFORM_TOOL_NAMES.setStatus]: setStatusTool,
};

export const DEFAULT_PLATFORM_TOOL_ORDER: readonly PlatformToolName[] = [
  PLATFORM_TOOL_NAMES.spawnAgent,
  PLATFORM_TOOL_NAMES.sendMessage,
  PLATFORM_TOOL_NAMES.listChildren,
  PLATFORM_TOOL_NAMES.wait,
  PLATFORM_TOOL_NAMES.finish,
  PLATFORM_TOOL_NAMES.setStatus,
];

/**
 * Build the platform tool set (0001:T3.3). Definitions are `toolCtx`-agnostic — the
 * per-call `ToolContext` (with the pre-bound clients + idempotency key) is
 * injected by the harness at `execute` time — so a single call here produces
 * the registry BOTH harnesses reuse (native 0001:T3.2, CASDK MCP server 0001:T7.2).
 */
export function platformTools(opts: PlatformToolsOptions = {}): AnyToolDefinition[] {
  const names = opts.include ?? DEFAULT_PLATFORM_TOOL_ORDER;
  return names.map((name) => {
    const factory = ALL_TOOL_FACTORIES[name];
    if (!factory) throw new Error(`platformTools: unknown platform tool ${JSON.stringify(name)}`);
    return factory();
  });
}

/** Convenience: the same tools keyed by name (for harnesses that index by name). */
export function platformToolsByName(
  opts: PlatformToolsOptions = {},
): Record<string, AnyToolDefinition> {
  const out: Record<string, AnyToolDefinition> = {};
  for (const tool of platformTools(opts)) out[tool.name] = tool;
  return out;
}
