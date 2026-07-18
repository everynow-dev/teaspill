import { describe, expect, it } from "vitest";
import type {
  ExecOptions,
  ExecResult,
  ToolContext,
  WorkspaceClient,
} from "./interface.js";
import { toolIdempotencyKey } from "./interface.js";
import {
  bashInputSchema,
  bashTool,
  DEFAULT_WORKSPACE_TOOL_ORDER,
  editFileInputSchema,
  editFileTool,
  lsTool,
  readFileTool,
  workspaceTools,
  workspaceToolsByName,
  WORKSPACE_TOOL_DESCRIPTIONS,
  WORKSPACE_TOOL_NAMES,
  writeFileTool,
  type WorkspaceToolName,
} from "./workspace-tools.js";

const ENTITY = "/t/default/a/coder/01jz00000000000000000000000";
const RUN = "run-abc";
const TOOL_USE = "toolu_xyz";
const WORKSPACE_REF = "ws-coder-1";

interface ExecCall {
  cmd: string;
  opts?: ExecOptions;
}

/**
 * A recording WorkspaceClient: captures calls + serves seeded file contents,
 * bound (by construction) to one tool invocation's idempotency key — exactly
 * how the harness constructs the per-call client (interface.ts invariant 1).
 */
class RecordingWorkspaceClient implements WorkspaceClient {
  readonly workspaceRef = WORKSPACE_REF;
  readonly execCalls: ExecCall[] = [];
  readonly readCalls: string[] = [];
  readonly writeCalls: Array<{ path: string; content: string }> = [];
  readonly lsCalls: string[] = [];
  #files = new Map<string, string>();
  #dirs = new Map<string, string[]>();
  #execResult: ExecResult = { exitCode: 0, tail: "", streamRef: "stream://x" };

  withFile(path: string, content: string): this {
    this.#files.set(path, content);
    return this;
  }
  withDir(path: string, entries: string[]): this {
    this.#dirs.set(path, entries);
    return this;
  }
  withExecResult(result: ExecResult): this {
    this.#execResult = result;
    return this;
  }

  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push(opts === undefined ? { cmd } : { cmd, opts });
    return Promise.resolve(this.#execResult);
  }
  readFile(path: string): Promise<string> {
    this.readCalls.push(path);
    const v = this.#files.get(path);
    if (v === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(v);
  }
  writeFile(path: string, content: string): Promise<void> {
    this.writeCalls.push({ path, content });
    this.#files.set(path, content);
    return Promise.resolve();
  }
  ls(path: string): Promise<string[]> {
    this.lsCalls.push(path);
    return Promise.resolve(this.#dirs.get(path) ?? []);
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  rm(): Promise<void> {
    return Promise.resolve();
  }
  stat(): Promise<{ kind: "file" | "dir"; size: number; mtimeMs: number }> {
    return Promise.resolve({ kind: "file", size: 0, mtimeMs: 0 });
  }
}

/**
 * A fake ToolContext bound to a fresh idempotency key — exactly how the harness
 * constructs it per call: `idempotencyKey` is derived from
 * `(entityUrl, runId, toolUseId)`, and the workspace client is "bound" to it.
 */
function makeToolCtx(
  workspace: WorkspaceClient | undefined,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  const toolUseId = overrides.toolUseId ?? TOOL_USE;
  const runId = overrides.runId ?? RUN;
  const entityUrl = overrides.entityUrl ?? ENTITY;
  return {
    entityUrl,
    runId,
    toolUseId,
    idempotencyKey: toolIdempotencyKey(entityUrl, runId, toolUseId),
    signal: new AbortController().signal,
    // Workspace tools never touch `platform`; a minimal stub keeps the type happy.
    platform: {
      spawn: () => Promise.reject(new Error("not used")),
      send: () => Promise.reject(new Error("not used")),
      listChildren: () => Promise.resolve([]),
    },
    ...(workspace !== undefined && { workspace }),
    ...overrides,
  };
}

function textOf(result: { content: Array<{ type: string }> }): string {
  return result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ===========================================================================
// Registry
// ===========================================================================

describe("registry — workspaceTools()", () => {
  it("returns all five tools in a stable default order with unique names", () => {
    const tools = workspaceTools();
    expect(tools.map((t) => t.name)).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "ls",
    ]);
    expect(tools.map((t) => t.name)).toEqual(DEFAULT_WORKSPACE_TOOL_ORDER as string[]);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("honors an include list (subset + order)", () => {
    const names: WorkspaceToolName[] = [WORKSPACE_TOOL_NAMES.readFile, WORKSPACE_TOOL_NAMES.ls];
    expect(workspaceTools({ include: names }).map((t) => t.name)).toEqual(["read_file", "ls"]);
  });

  it("throws on an unknown tool name", () => {
    expect(() =>
      workspaceTools({ include: ["nope" as WorkspaceToolName] }),
    ).toThrow(/unknown workspace tool/);
  });

  it("workspaceToolsByName keys every tool by its name", () => {
    const byName = workspaceToolsByName();
    expect(Object.keys(byName).sort()).toEqual(
      ["bash", "edit_file", "ls", "read_file", "write_file"].sort(),
    );
  });

  it("every tool carries a non-empty model-facing description matching the table", () => {
    for (const tool of workspaceTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description).toBe(
        WORKSPACE_TOOL_DESCRIPTIONS[tool.name as WorkspaceToolName],
      );
    }
  });
});

// ===========================================================================
// bash
// ===========================================================================

describe("bash", () => {
  it("dispatches the command + clamped timeout to the bound workspace client", async () => {
    const ws = new RecordingWorkspaceClient().withExecResult({
      exitCode: 0,
      tail: "hello\n",
      streamRef: "stream://exec-1",
    });
    const ctx = makeToolCtx(ws);
    const result = await bashTool().execute({ command: "echo hello" }, ctx);

    expect(ws.execCalls).toHaveLength(1);
    expect(ws.execCalls[0]?.cmd).toBe("echo hello");
    expect(ws.execCalls[0]?.opts?.timeoutMs).toBe(120_000);
    // The client used is the one bound to this call's idempotency key.
    expect(ctx.idempotencyKey).toBe(toolIdempotencyKey(ENTITY, RUN, TOOL_USE));
    expect(ctx.workspace?.workspaceRef).toBe(WORKSPACE_REF);
    expect(textOf(result)).toContain("hello");
    expect(result.isError).toBeFalsy();
    expect(result.detail).toMatchObject({ exitCode: 0, streamRef: "stream://exec-1" });
  });

  it("passes cwd/env through and clamps an over-large timeout", async () => {
    const ws = new RecordingWorkspaceClient();
    const ctx = makeToolCtx(ws);
    await bashTool().execute(
      { command: "ls", cwd: "sub", env: { FOO: "bar" }, timeoutMs: 9_999_999 },
      ctx,
    );
    expect(ws.execCalls[0]?.opts).toMatchObject({
      cwd: "sub",
      env: { FOO: "bar" },
      timeoutMs: 600_000,
    });
  });

  it("forwards ctx.signal as ExecOptions.signal (0002:T3.1 abort → kill plumbing)", async () => {
    const ws = new RecordingWorkspaceClient();
    const ac = new AbortController();
    const ctx = makeToolCtx(ws, { signal: ac.signal });
    await bashTool().execute({ command: "sleep 100" }, ctx);
    // The SAME signal object is threaded through so the client can map an abort
    // onto the workspace kill path (the signal never travels to the process).
    expect(ws.execCalls[0]?.opts?.signal).toBe(ac.signal);
  });

  it("surfaces a non-zero exit code in the text and detail", async () => {
    const ws = new RecordingWorkspaceClient().withExecResult({
      exitCode: 2,
      tail: "boom",
      streamRef: "stream://exec-2",
    });
    const result = await bashTool().execute({ command: "false" }, makeToolCtx(ws));
    expect(textOf(result)).toContain("[exit code: 2]");
    expect(result.detail).toMatchObject({ exitCode: 2 });
  });

  it("schema rejects an empty command and unknown keys", () => {
    expect(bashInputSchema.safeParse({ command: "" }).success).toBe(false);
    expect(bashInputSchema.safeParse({ command: "ls", bogus: 1 }).success).toBe(false);
    expect(bashInputSchema.safeParse({ command: "ls" }).success).toBe(true);
  });

  it("returns a non-fatal error when the agent has no workspace", async () => {
    const result = await bashTool().execute({ command: "ls" }, makeToolCtx(undefined));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no workspace");
  });
});

// ===========================================================================
// read_file / write_file / ls
// ===========================================================================

describe("read_file", () => {
  it("returns the file contents from the workspace client", async () => {
    const ws = new RecordingWorkspaceClient().withFile("a.txt", "line1\nline2");
    const result = await readFileTool().execute({ path: "a.txt" }, makeToolCtx(ws));
    expect(ws.readCalls).toEqual(["a.txt"]);
    expect(textOf(result)).toBe("line1\nline2");
    expect(result.detail).toMatchObject({ path: "a.txt" });
  });

  it("no-workspace guard", async () => {
    const result = await readFileTool().execute({ path: "a.txt" }, makeToolCtx(undefined));
    expect(result.isError).toBe(true);
  });
});

describe("write_file", () => {
  it("dispatches path + full content to the workspace client", async () => {
    const ws = new RecordingWorkspaceClient();
    const result = await writeFileTool().execute(
      { path: "out/x.txt", content: "hello world" },
      makeToolCtx(ws),
    );
    expect(ws.writeCalls).toEqual([{ path: "out/x.txt", content: "hello world" }]);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("out/x.txt");
    expect(result.detail).toMatchObject({ path: "out/x.txt", bytes: 11 });
  });
});

describe("ls", () => {
  it("lists a directory", async () => {
    const ws = new RecordingWorkspaceClient().withDir("sub", ["a", "b"]);
    const result = await lsTool().execute({ path: "sub" }, makeToolCtx(ws));
    expect(ws.lsCalls).toEqual(["sub"]);
    expect(textOf(result)).toBe("a\nb");
    expect(result.detail).toMatchObject({ path: "sub", entries: ["a", "b"] });
  });

  it("defaults to the workspace root when path is omitted", async () => {
    const ws = new RecordingWorkspaceClient().withDir(".", ["root.txt"]);
    await lsTool().execute({}, makeToolCtx(ws));
    expect(ws.lsCalls).toEqual(["."]);
  });

  it("reports an empty directory", async () => {
    const ws = new RecordingWorkspaceClient().withDir("empty", []);
    const result = await lsTool().execute({ path: "empty" }, makeToolCtx(ws));
    expect(textOf(result)).toContain("empty directory");
  });
});

// ===========================================================================
// edit_file — unique-match-or-fail (the minefield: all three cases)
// ===========================================================================

describe("edit_file — unique-match-or-fail", () => {
  it("replaces a unique match and writes back", async () => {
    const ws = new RecordingWorkspaceClient().withFile("f.ts", "const a = 1;\nconst b = 2;\n");
    const result = await editFileTool().execute(
      { path: "f.ts", old_string: "const a = 1;", new_string: "const a = 42;" },
      makeToolCtx(ws),
    );
    expect(result.isError).toBeFalsy();
    expect(ws.writeCalls).toEqual([{ path: "f.ts", content: "const a = 42;\nconst b = 2;\n" }]);
    expect(result.detail).toMatchObject({ replacements: 1 });
  });

  it("fails with 'not found' on 0 matches and does NOT write", async () => {
    const ws = new RecordingWorkspaceClient().withFile("f.ts", "const a = 1;\n");
    const result = await editFileTool().execute(
      { path: "f.ts", old_string: "const zzz = 9;", new_string: "x" },
      makeToolCtx(ws),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
    expect(ws.writeCalls).toHaveLength(0);
    expect(result.detail).toMatchObject({ replacements: 0 });
  });

  it("fails as 'not unique' on >1 matches and does NOT write", async () => {
    const ws = new RecordingWorkspaceClient().withFile("f.ts", "x = 1;\nx = 1;\nx = 1;\n");
    const result = await editFileTool().execute(
      { path: "f.ts", old_string: "x = 1;", new_string: "x = 2;" },
      makeToolCtx(ws),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not unique");
    expect(textOf(result)).toContain("3 matches");
    expect(ws.writeCalls).toHaveLength(0);
    expect(result.detail).toMatchObject({ replacements: 0, matches: 3 });
  });

  it("schema requires a non-empty old_string and rejects unknown keys", () => {
    expect(
      editFileInputSchema.safeParse({ path: "f", old_string: "", new_string: "y" }).success,
    ).toBe(false);
    expect(
      editFileInputSchema.safeParse({ path: "f", old_string: "a", new_string: "y", bad: 1 })
        .success,
    ).toBe(false);
    expect(
      editFileInputSchema.safeParse({ path: "f", old_string: "a", new_string: "" }).success,
    ).toBe(true);
  });

  it("no-workspace guard", async () => {
    const result = await editFileTool().execute(
      { path: "f", old_string: "a", new_string: "b" },
      makeToolCtx(undefined),
    );
    expect(result.isError).toBe(true);
  });
});
