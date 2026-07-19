/**
 * Workspace tools (0001:T4.3) — the filesystem/exec toolset an agent with a
 * workspace (0001:D4) exposes to the model, defined against the FROZEN 0001:T3.1 tool
 * interface (`ToolDefinition` / `ToolContext` in ./interface.ts) so BOTH
 * harnesses consume the same registry: the pi-ai native harness (0001:T3.2) and the
 * CASDK in-process MCP server (0001:T7.2). Mirrors the platform-tools pattern in
 * ./tools.ts exactly.
 *
 * ## The tools
 *
 * - `bash(command, …)` — run a shell command in the agent's workspace; returns
 *   exit code + a bounded output tail (+ a `streamRef` to the full output).
 * - `read_file(path)` — read a UTF-8 text file from the workspace.
 * - `write_file(path, content)` — create/overwrite a file (parents created).
 * - `ls(path?)` — list a directory (defaults to the workspace root).
 * - `edit_file(path, old_string, new_string)` — UNIQUE-MATCH-OR-FAIL string
 *   replace: `old_string` must occur EXACTLY ONCE.
 *
 * ## edit_file — unique-match-or-fail (the model-ergonomics minefield)
 *
 * Semantics are COPIED from electric's proven `edit` tool
 * (`../electric/packages/agents-runtime/src/tools/edit.ts`), reduced to the
 * strict single-match form PLAN 0001:T4.3 calls for:
 *
 * - 0 matches  → error "not found" (the model must re-read / fix `old_string`).
 * - >1 matches → error "not unique, add more context" (the model must extend
 *   `old_string` with surrounding lines until it is unique).
 * - exactly 1  → replace and write.
 *
 * The description TEACHES this contract to the model, and the tests assert on
 * the description text + all three match cases so a future edit cannot silently
 * drop the teaching or regress the uniqueness check.
 *
 * ## How effects route (0001:T3.1 exactly-once contract)
 *
 * Every method drives the `WorkspaceClient` injected on `ToolContext.workspace`,
 * which is pre-BOUND to this call's idempotency key `(entityUrl, runId,
 * toolUseId)` (interface.ts invariant 1): tool code just calls
 * `ctx.workspace.*` and the client renders/attaches the key and routes the
 * side-effecting calls (`exec`/`writeFile`) through the workspace virtual
 * object, so effects are exactly-once under any retry granularity. `edit_file`
 * is a read-modify-write: its terminal `writeFile` carries the key. Read-only
 * calls (`read_file`, `ls`, and `edit_file`'s initial read) need no key.
 *
 * ## workspaceRef / auto-ensure
 *
 * Tools read the agent's workspace from `ctx.workspace` — the client is bound
 * to the agent's `workspaceRef` (0001:D4) and the workspace host is expected to
 * `ensure` the workspace on first use (idempotent). When the agent has NO
 * workspace (`ctx.workspace` is undefined, per the frozen `ToolContext`), each
 * tool returns a non-fatal error telling the model this agent has no workspace
 * rather than throwing.
 */

import { z } from "zod";
import type { JsonValue } from "@teaspill/schema";
import type {
  AnyToolDefinition,
  ExecOptions,
  ToolDefinition,
  ToolExecutionResult,
  WorkspaceClient,
} from "./interface.js";
import { injectTraceContext } from "./otel.js";

// ===========================================================================
// Tool names (exported so 0001:T3.2/0001:T7.2 don't hardcode strings)
// ===========================================================================

export const WORKSPACE_TOOL_NAMES = {
  bash: "bash",
  readFile: "read_file",
  writeFile: "write_file",
  editFile: "edit_file",
  ls: "ls",
} as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[keyof typeof WORKSPACE_TOOL_NAMES];

// ===========================================================================
// Limits
// ===========================================================================

const DEFAULT_TIMEOUT_MS = 120_000; // 2 min
const MAX_TIMEOUT_MS = 600_000; // 10 min

// ===========================================================================
// Zod input schemas (strict, model-facing descriptions)
// ===========================================================================

export const bashInputSchema = z
  .object({
    command: z.string().min(1).describe("The shell command to execute in the workspace."),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe("Optional working directory for the command, relative to the workspace root."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional extra environment variables for this command."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optional timeout in milliseconds. Defaults to 120000 (2 min), clamped to 600000 (10 min).",
      ),
  })
  .strict();
export type BashInput = z.infer<typeof bashInputSchema>;

export const readFileInputSchema = z
  .object({
    path: z.string().min(1).describe("File path to read, relative to the workspace root."),
  })
  .strict();
export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export const writeFileInputSchema = z
  .object({
    path: z.string().min(1).describe("File path to write, relative to the workspace root."),
    content: z.string().describe("The FULL file contents to write (overwrites any existing file)."),
  })
  .strict();
export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

export const editFileInputSchema = z
  .object({
    path: z.string().min(1).describe("File path to edit, relative to the workspace root."),
    old_string: z
      .string()
      .min(1)
      .describe(
        "The literal text to find, exactly as it appears in the file (do NOT include read-tool " +
          "line-number prefixes like '42: '). Must occur EXACTLY ONCE in the file — include " +
          "enough surrounding context to make it unique.",
      ),
    new_string: z.string().describe("The replacement text."),
  })
  .strict();
export type EditFileInput = z.infer<typeof editFileInputSchema>;

export const lsInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Directory to list, relative to the workspace root. Defaults to the root."),
  })
  .strict();
export type LsInput = z.infer<typeof lsInputSchema>;

// ===========================================================================
// Model-facing descriptions (the teaching — asserted on in tests)
// ===========================================================================

export const WORKSPACE_TOOL_DESCRIPTIONS = {
  bash:
    "Execute a shell command in this agent's workspace and return its exit code and output. The " +
    "command runs to completion (default 2-minute timeout, max 10 minutes via timeoutMs). Only a " +
    "bounded TAIL of stdout/stderr is returned inline; the full output is captured to a stream " +
    "referenced by `streamRef` in the result detail. A non-zero exit code means the command " +
    "failed — read the output and adjust. Prefer the dedicated read_file/write_file/edit_file/ls " +
    "tools over shell equivalents (cat/echo/sed/ls) for file work.",
  read_file:
    "Read the contents of a UTF-8 text file in the workspace, by path relative to the workspace " +
    "root. Use this before editing a file so your edit_file `old_string` matches the file exactly.",
  write_file:
    "Create or overwrite a file in the workspace with the given content. Writes the FULL contents " +
    "you provide (any existing file at that path is replaced); parent directories are created as " +
    "needed. To change part of an existing file, prefer edit_file so you don't have to restate the " +
    "whole file.",
  edit_file:
    "Replace text in an existing workspace file. `old_string` must appear EXACTLY ONCE in the " +
    "file, and it is replaced with `new_string`. If `old_string` is NOT FOUND, the edit fails — " +
    "re-read the file and correct it. If `old_string` matches MORE THAN ONCE, the edit fails as " +
    "NOT UNIQUE — extend `old_string` with more surrounding context (e.g. neighboring lines) until " +
    "it identifies a single location, then try again. Copy `old_string` verbatim from the file; do " +
    "NOT include read-tool line-number prefixes like '42: '.",
  ls:
    "List the entries of a directory in the workspace (relative to the workspace root; omit `path` " +
    "to list the root). Read-only.",
} as const satisfies Record<WorkspaceToolName, string>;

// ===========================================================================
// Result helpers
// ===========================================================================

function textResult(text: string, detail?: JsonValue): ToolExecutionResult {
  return detail === undefined
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }], detail };
}

function errorResult(text: string, detail?: JsonValue): ToolExecutionResult {
  return detail === undefined
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }], isError: true, detail };
}

/**
 * Resolve the bound workspace client, or a non-fatal error result telling the
 * model this agent has no workspace. The workspace host is expected to `ensure`
 * the workspace lazily on first use — tool code does not ensure explicitly.
 */
function requireWorkspace(
  ws: WorkspaceClient | undefined,
  toolName: string,
): { ok: true; ws: WorkspaceClient } | { ok: false; result: ToolExecutionResult } {
  if (!ws) {
    return {
      ok: false,
      result: errorResult(
        `Cannot run \`${toolName}\`: this agent has no workspace. Workspace tools require the ` +
          `agent to be configured with a workspaceRef.`,
      ),
    };
  }
  return { ok: true, ws };
}

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(ms), 1), MAX_TIMEOUT_MS);
}

// ===========================================================================
// Tool definitions
// ===========================================================================

/**
 * `bash` — side-effecting. Drives `ctx.workspace.exec` (pre-bound to the
 * idempotency key), awaiting the long-exec completion (0001:T4.1). Returns exit code
 * + bounded tail; the full output lives at `streamRef`.
 *
 * Forwards `ctx.signal` as `ExecOptions.signal` (0002:T3.1) so the same abort
 * that stops the run also stops its in-flight exec. The signal does NOT travel
 * to the process (it crosses a Restate ingress boundary); the `WorkspaceClient`
 * maps it onto the workspace `kill` path client-side. See `WorkspaceClient.exec`.
 */
export function bashTool(): ToolDefinition<BashInput> {
  return {
    name: WORKSPACE_TOOL_NAMES.bash,
    description: WORKSPACE_TOOL_DESCRIPTIONS.bash,
    schema: bashInputSchema,
    async execute(input, ctx): Promise<ToolExecutionResult> {
      const guard = requireWorkspace(ctx.workspace, WORKSPACE_TOOL_NAMES.bash);
      if (!guard.ok) return guard.result;

      const opts: ExecOptions = {
        timeoutMs: clampTimeout(input.timeoutMs),
        signal: ctx.signal,
        ...(input.cwd !== undefined && { cwd: input.cwd }),
        ...(input.env !== undefined && { env: input.env }),
      };
      // 0002:T3.3: thread the ACTIVE span (the per-tool-call `tool.call` span
      // opened by the harness step loop) onto the exec-options ENVELOPE so the
      // executor's `workspace.exec` span parents under this run. No-op when no
      // tracer is registered (writes nothing → envelope unchanged, 0001:A5).
      injectTraceContext(opts as Record<string, unknown>);
      const { exitCode, tail, streamRef } = await guard.ws.exec(input.command, opts);

      const body = tail.length > 0 ? tail : "(no output)";
      const text = exitCode === 0 ? body : `${body}\n\n[exit code: ${exitCode}]`;
      const detail: JsonValue = {
        exitCode,
        ...(streamRef !== undefined && { streamRef }),
      };
      return textResult(text, detail);
    },
  };
}

/** `read_file` — read-only. Drives `ctx.workspace.readFile`; no idempotency key needed. */
export function readFileTool(): ToolDefinition<ReadFileInput> {
  return {
    name: WORKSPACE_TOOL_NAMES.readFile,
    description: WORKSPACE_TOOL_DESCRIPTIONS.read_file,
    schema: readFileInputSchema,
    async execute(input, ctx): Promise<ToolExecutionResult> {
      const guard = requireWorkspace(ctx.workspace, WORKSPACE_TOOL_NAMES.readFile);
      if (!guard.ok) return guard.result;
      const content = await guard.ws.readFile(input.path);
      return textResult(content, { path: input.path, bytes: content.length });
    },
  };
}

/** `write_file` — side-effecting. Drives `ctx.workspace.writeFile` (idempotency-keyed). */
export function writeFileTool(): ToolDefinition<WriteFileInput> {
  return {
    name: WORKSPACE_TOOL_NAMES.writeFile,
    description: WORKSPACE_TOOL_DESCRIPTIONS.write_file,
    schema: writeFileInputSchema,
    async execute(input, ctx): Promise<ToolExecutionResult> {
      const guard = requireWorkspace(ctx.workspace, WORKSPACE_TOOL_NAMES.writeFile);
      if (!guard.ok) return guard.result;
      await guard.ws.writeFile(input.path, input.content);
      const bytes = input.content.length;
      return textResult(`Wrote ${bytes} bytes to ${input.path}.`, { path: input.path, bytes });
    },
  };
}

/**
 * `edit_file` — UNIQUE-MATCH-OR-FAIL, semantics copied from electric's `edit`.
 * Read-modify-write: `readFile` (read-only) then, only on a unique match,
 * `writeFile` (side-effecting, carries the bound idempotency key). 0 matches →
 * "not found"; >1 → "not unique, add more context"; exactly 1 → replace.
 */
export function editFileTool(): ToolDefinition<EditFileInput> {
  return {
    name: WORKSPACE_TOOL_NAMES.editFile,
    description: WORKSPACE_TOOL_DESCRIPTIONS.edit_file,
    schema: editFileInputSchema,
    async execute(input, ctx): Promise<ToolExecutionResult> {
      const guard = requireWorkspace(ctx.workspace, WORKSPACE_TOOL_NAMES.editFile);
      if (!guard.ok) return guard.result;
      const { path, old_string, new_string } = input;

      const original = await guard.ws.readFile(path);
      const matches = original.split(old_string).length - 1;

      if (matches === 0) {
        return errorResult(
          `Error: old_string not found in ${path}. Re-read the file and make sure old_string ` +
            `matches the file exactly (no line-number prefixes).`,
          { path, replacements: 0 },
        );
      }
      if (matches > 1) {
        return errorResult(
          `Error: old_string is not unique in ${path} — found ${matches} matches. Add more ` +
            `surrounding context to old_string so it identifies a single location.`,
          { path, replacements: 0, matches },
        );
      }

      const updated = original.split(old_string).join(new_string);
      await guard.ws.writeFile(path, updated);
      return textResult(`Edited ${path}: 1 replacement.`, { path, replacements: 1 });
    },
  };
}

/** `ls` — read-only. Drives `ctx.workspace.ls`; defaults to the workspace root. */
export function lsTool(): ToolDefinition<LsInput> {
  return {
    name: WORKSPACE_TOOL_NAMES.ls,
    description: WORKSPACE_TOOL_DESCRIPTIONS.ls,
    schema: lsInputSchema,
    async execute(input, ctx): Promise<ToolExecutionResult> {
      const guard = requireWorkspace(ctx.workspace, WORKSPACE_TOOL_NAMES.ls);
      if (!guard.ok) return guard.result;
      const path = input.path ?? ".";
      const entries = await guard.ws.ls(path);
      const text =
        entries.length === 0 ? `(empty directory: ${path})` : entries.join("\n");
      return textResult(text, { path, entries });
    },
  };
}

// ===========================================================================
// Registry — the seam both harnesses consume
// ===========================================================================

export interface WorkspaceToolsOptions {
  /**
   * Restrict the returned set to these tool names (in this order). Omit for all
   * five. Lets a harness/agent config drop tools it does not want the model to
   * have (e.g. a read-only agent with no `write_file`/`edit_file`/`bash`).
   */
  include?: readonly WorkspaceToolName[];
}

const ALL_TOOL_FACTORIES: Record<WorkspaceToolName, () => AnyToolDefinition> = {
  [WORKSPACE_TOOL_NAMES.bash]: bashTool,
  [WORKSPACE_TOOL_NAMES.readFile]: readFileTool,
  [WORKSPACE_TOOL_NAMES.writeFile]: writeFileTool,
  [WORKSPACE_TOOL_NAMES.editFile]: editFileTool,
  [WORKSPACE_TOOL_NAMES.ls]: lsTool,
};

export const DEFAULT_WORKSPACE_TOOL_ORDER: readonly WorkspaceToolName[] = [
  WORKSPACE_TOOL_NAMES.bash,
  WORKSPACE_TOOL_NAMES.readFile,
  WORKSPACE_TOOL_NAMES.writeFile,
  WORKSPACE_TOOL_NAMES.editFile,
  WORKSPACE_TOOL_NAMES.ls,
];

/**
 * Build the workspace tool set (0001:T4.3). Definitions are `toolCtx`-agnostic — the
 * per-call `ToolContext` (with the pre-bound workspace client + idempotency
 * key) is injected by the harness at `execute` time — so a single call here
 * produces the registry BOTH harnesses reuse (native 0001:T3.2, CASDK MCP 0001:T7.2),
 * alongside `platformTools()`.
 */
export function workspaceTools(opts: WorkspaceToolsOptions = {}): AnyToolDefinition[] {
  const names = opts.include ?? DEFAULT_WORKSPACE_TOOL_ORDER;
  return names.map((name) => {
    const factory = ALL_TOOL_FACTORIES[name];
    if (!factory) throw new Error(`workspaceTools: unknown workspace tool ${JSON.stringify(name)}`);
    return factory();
  });
}

/** Convenience: the same tools keyed by name (for harnesses that index by name). */
export function workspaceToolsByName(
  opts: WorkspaceToolsOptions = {},
): Record<string, AnyToolDefinition> {
  const out: Record<string, AnyToolDefinition> = {};
  for (const tool of workspaceTools(opts)) out[tool.name] = tool;
  return out;
}
