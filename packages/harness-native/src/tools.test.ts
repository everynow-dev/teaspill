import { describe, expect, it, vi } from "vitest";
import type {
  PlatformClient,
  SendRequest,
  SpawnRequest,
  ToolContext,
} from "./interface.js";
import { toolIdempotencyKey } from "./interface.js";
import {
  DEFAULT_PLATFORM_TOOL_ORDER,
  finishTool,
  isTerminalControl,
  listChildrenTool,
  PLATFORM_CONTROL_KEY,
  PLATFORM_TOOL_DESCRIPTIONS,
  PLATFORM_TOOL_NAMES,
  platformTools,
  platformToolsByName,
  readPlatformControlSignal,
  sendMessageTool,
  setStatusTool,
  spawnAgentTool,
  waitTool,
  type PlatformToolName,
} from "./tools.js";

const ENTITY = "/t/default/a/orchestrator/01jz00000000000000000000000";
const RUN = "run-abc";
const TOOL_USE = "toolu_xyz";

/** A recording PlatformClient that captures calls; bound to one tool invocation. */
class RecordingPlatformClient implements PlatformClient {
  readonly spawnCalls: SpawnRequest[] = [];
  readonly sendCalls: SendRequest[] = [];
  listChildrenCalls = 0;
  #children: Array<{ entityId: string; entityType: string; status: string }> = [];

  withChildren(children: Array<{ entityId: string; entityType: string; status: string }>): this {
    this.#children = children;
    return this;
  }
  spawn(req: SpawnRequest): Promise<{ entityId: string }> {
    this.spawnCalls.push(req);
    const id = req.id ?? "01jz-child-generated";
    return Promise.resolve({ entityId: `/t/default/a/${req.entityType}/${id}` });
  }
  send(req: SendRequest): Promise<void> {
    this.sendCalls.push(req);
    return Promise.resolve();
  }
  listChildren(): Promise<Array<{ entityId: string; entityType: string; status: string }>> {
    this.listChildrenCalls++;
    return Promise.resolve(this.#children);
  }
}

/**
 * A fake ToolContext bound to a fresh idempotency key — exactly how the harness
 * constructs it per call (interface.ts): `idempotencyKey` is derived from
 * `(entityUrl, runId, toolUseId)`, and the platform client is "bound" to it.
 */
function makeToolCtx(platform: PlatformClient, overrides: Partial<ToolContext> = {}): ToolContext {
  const toolUseId = overrides.toolUseId ?? TOOL_USE;
  const runId = overrides.runId ?? RUN;
  const entityUrl = overrides.entityUrl ?? ENTITY;
  return {
    entityUrl,
    runId,
    toolUseId,
    idempotencyKey: toolIdempotencyKey(entityUrl, runId, toolUseId),
    signal: new AbortController().signal,
    platform,
    ...overrides,
  };
}

describe("registry — platformTools()", () => {
  it("returns all six tools in a stable default order with unique names", () => {
    const tools = platformTools();
    expect(tools.map((t) => t.name)).toEqual([
      "spawn_agent",
      "send_message",
      "list_children",
      "wait",
      "finish",
      "set_status",
    ]);
    expect(tools.map((t) => t.name)).toEqual(DEFAULT_PLATFORM_TOOL_ORDER as string[]);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("every tool has a zod schema and a non-empty model-facing description", () => {
    for (const tool of platformTools()) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(20);
      // schema must actually parse (smoke): empty object is valid only for list_children/no-arg
      expect(tool.schema).toBeDefined();
    }
  });

  it("`include` restricts and re-orders the set", () => {
    const only: PlatformToolName[] = [PLATFORM_TOOL_NAMES.wait, PLATFORM_TOOL_NAMES.spawnAgent];
    expect(platformTools({ include: only }).map((t) => t.name)).toEqual(["wait", "spawn_agent"]);
  });

  it("platformToolsByName indexes by tool name", () => {
    const byName = platformToolsByName();
    expect(Object.keys(byName).sort()).toEqual(
      [...DEFAULT_PLATFORM_TOOL_ORDER].sort(),
    );
    expect(byName["spawn_agent"]!.name).toBe("spawn_agent");
  });
});

describe("descriptions TEACH the async/wake model (guard against silent drift)", () => {
  it("spawn_agent teaches: returns immediately, result arrives later as child_finished", () => {
    const d = PLATFORM_TOOL_DESCRIPTIONS.spawn_agent;
    expect(d).toMatch(/IMMEDIATELY/);
    expect(d).toMatch(/child_finished/);
    expect(d).toMatch(/later|future wake/i);
    expect(d).toMatch(/does NOT wait|do not block|not block/i);
  });

  it("wait teaches: returns immediately, NO synchronous blocking, re-woken by the wake model", () => {
    const d = PLATFORM_TOOL_DESCRIPTIONS.wait;
    expect(d).toMatch(/IMMEDIATELY/);
    expect(d).toMatch(/does NOT block|not block/i);
    expect(d).toMatch(/re-woken|wake/i);
    expect(d).toMatch(/no synchronous/i);
  });

  it("send_message teaches: fire-and-forget, reply arrives on a future wake", () => {
    const d = PLATFORM_TOOL_DESCRIPTIONS.send_message;
    expect(d).toMatch(/fire-and-forget/i);
    expect(d).toMatch(/enqueued/i);
    expect(d).toMatch(/later|future wake/i);
  });

  it("finish/list_children/set_status descriptions exist and are non-trivial", () => {
    expect(PLATFORM_TOOL_DESCRIPTIONS.finish).toMatch(/child_finished/);
    expect(PLATFORM_TOOL_DESCRIPTIONS.list_children).toMatch(/child_finished/);
    expect(PLATFORM_TOOL_DESCRIPTIONS.set_status.length).toBeGreaterThan(20);
  });

  it("list_children teaches: not a poll/check for a child's result (0002:T4.4 soak)", () => {
    // A small model told to 'check whether the child finished' reached for
    // list_children (then self-corrected). This pins the strengthened
    // anti-poll teaching so a future edit cannot silently drop it.
    const d = PLATFORM_TOOL_DESCRIPTIONS.list_children;
    expect(d).toMatch(/not.*poll|nothing to poll/i);
    expect(d).toMatch(/check whether a child has finished|do not .*check/i);
  });

  it("each tool.description matches its canonical description string", () => {
    for (const tool of platformTools()) {
      expect(tool.description).toBe(
        PLATFORM_TOOL_DESCRIPTIONS[tool.name as PlatformToolName],
      );
    }
  });
});

describe("spawn_agent", () => {
  it("schema accepts type+args and rejects missing type / unknown keys", () => {
    const s = spawnAgentTool().schema;
    expect(s.safeParse({ type: "researcher", args: { topic: "x" } }).success).toBe(true);
    expect(s.safeParse({ args: {} }).success).toBe(false); // no type
    expect(s.safeParse({ type: "" }).success).toBe(false); // empty type
    expect(s.safeParse({ type: "r", bogus: 1 }).success).toBe(false); // strict
  });

  it("drives ctx.platform.spawn and RETURNS the child id synchronously (not the result)", async () => {
    const platform = new RecordingPlatformClient();
    const ctx = makeToolCtx(platform);
    const res = await spawnAgentTool().execute(
      { type: "researcher", args: { topic: "tea" }, id: "child-1" },
      ctx,
    );
    // The child id is available immediately…
    expect(platform.spawnCalls).toHaveLength(1);
    expect(platform.spawnCalls[0]).toEqual({
      entityType: "researcher",
      args: { topic: "tea" },
      id: "child-1",
    });
    expect(res.detail).toMatchObject({ entityId: "/t/default/a/researcher/child-1" });
    // …and it is NOT a control signal (spawn does not end the turn).
    expect(readPlatformControlSignal(res)).toBeNull();
  });

  it("the injected client is bound to the (entityUrl, runId, toolUseId) idempotency key", async () => {
    const platform = new RecordingPlatformClient();
    const ctx = makeToolCtx(platform, { toolUseId: "toolu_spawn_1" });
    // The exactly-once contract: the ctx handed to execute carries the key the
    // bound client routes through Restate ingress (interface.ts invariant 1).
    expect(ctx.idempotencyKey).toBe(toolIdempotencyKey(ENTITY, RUN, "toolu_spawn_1"));
    await spawnAgentTool().execute({ type: "researcher" }, ctx);
    expect(platform.spawnCalls).toHaveLength(1);
    // A retried run re-issues the SAME logical key for the same toolUseId.
    const ctx2 = makeToolCtx(new RecordingPlatformClient(), { toolUseId: "toolu_spawn_1" });
    expect(ctx2.idempotencyKey).toBe(ctx.idempotencyKey);
  });
});

describe("send_message", () => {
  it("schema requires to+message, allows mode, rejects unknown keys", () => {
    const s = sendMessageTool().schema;
    expect(s.safeParse({ to: "/t/d/a/x/y", message: "hi" }).success).toBe(true);
    expect(s.safeParse({ to: "/t/d/a/x/y", message: "hi", mode: "steer" }).success).toBe(true);
    expect(s.safeParse({ to: "/t/d/a/x/y", message: "hi", mode: "bogus" }).success).toBe(false);
    expect(s.safeParse({ message: "hi" }).success).toBe(false); // no to
    expect(s.safeParse({ to: "x", message: "" }).success).toBe(false); // empty message
  });

  it("drives ctx.platform.send with wrapped content and returns on enqueue", async () => {
    const platform = new RecordingPlatformClient();
    const res = await sendMessageTool().execute(
      { to: "/t/default/a/peer/z", message: "ping", mode: "steer" },
      makeToolCtx(platform),
    );
    expect(platform.sendCalls).toEqual([
      { to: "/t/default/a/peer/z", content: [{ type: "text", text: "ping" }], mode: "steer" },
    ]);
    expect(readPlatformControlSignal(res)).toBeNull();
  });
});

describe("list_children (read-only, no idempotency needed)", () => {
  it("schema takes no args (strict empty object)", () => {
    const s = listChildrenTool().schema;
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ anything: 1 }).success).toBe(false);
  });

  it("reads ctx.platform.listChildren and renders them; no control signal", async () => {
    const platform = new RecordingPlatformClient().withChildren([
      { entityId: "/t/default/a/researcher/a", entityType: "researcher", status: "active" },
    ]);
    const res = await listChildrenTool().execute({}, makeToolCtx(platform));
    expect(platform.listChildrenCalls).toBe(1);
    expect(platform.spawnCalls).toHaveLength(0);
    expect(platform.sendCalls).toHaveLength(0);
    expect(res.detail).toMatchObject({ children: [{ status: "active" }] });
    expect(readPlatformControlSignal(res)).toBeNull();
  });

  it("renders an empty children list clearly", async () => {
    const res = await listChildrenTool().execute({}, makeToolCtx(new RecordingPlatformClient()));
    expect(res.content[0]).toMatchObject({ type: "text", text: "No children spawned yet." });
  });
});

describe("wait (returns immediately, yields the turn — NEVER touches the client)", () => {
  it("returns a terminal `wait` control signal and calls no client method", async () => {
    const platform = new RecordingPlatformClient();
    const spawnSpy = vi.spyOn(platform, "spawn");
    const sendSpy = vi.spyOn(platform, "send");
    const res = await waitTool().execute({ reason: "3 children" }, makeToolCtx(platform));
    const signal = readPlatformControlSignal(res);
    expect(signal).toEqual({ kind: "wait", reason: "3 children" });
    expect(signal && isTerminalControl(signal)).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("resolves synchronously-ish (no awaiting of any external effect)", async () => {
    // The promise is already-resolved: the tool does no I/O.
    const res = await waitTool().execute({}, makeToolCtx(new RecordingPlatformClient()));
    expect(readPlatformControlSignal(res)).toEqual({ kind: "wait" });
  });
});

describe("finish / set_status (control tools)", () => {
  it("finish returns a terminal `finish` signal carrying the result", async () => {
    const res = await finishTool().execute(
      { result: { ok: true }, summary: "done" },
      makeToolCtx(new RecordingPlatformClient()),
    );
    const signal = readPlatformControlSignal(res);
    expect(signal).toEqual({ kind: "finish", result: { ok: true } });
    expect(signal && isTerminalControl(signal)).toBe(true);
  });

  it("set_status returns a NON-terminal `set_status` signal", async () => {
    const res = await setStatusTool().execute(
      { status: "researching" },
      makeToolCtx(new RecordingPlatformClient()),
    );
    const signal = readPlatformControlSignal(res);
    expect(signal).toEqual({ kind: "set_status", status: "researching" });
    expect(signal && isTerminalControl(signal)).toBe(false);
  });

  it("set_status schema enforces a non-empty, bounded status string", () => {
    const s = setStatusTool().schema;
    expect(s.safeParse({ status: "ok" }).success).toBe(true);
    expect(s.safeParse({ status: "" }).success).toBe(false);
    expect(s.safeParse({ status: "x".repeat(201) }).success).toBe(false);
  });

  it("finish schema allows empty input (result optional) and rejects unknown keys", () => {
    const s = finishTool().schema;
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ result: [1, 2, 3] }).success).toBe(true);
    expect(s.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("readPlatformControlSignal", () => {
  it("returns null for ordinary tool results and malformed detail", () => {
    expect(readPlatformControlSignal({ content: [] })).toBeNull();
    expect(readPlatformControlSignal({ content: [], detail: { some: "thing" } })).toBeNull();
    expect(readPlatformControlSignal({ content: [], detail: [1, 2] })).toBeNull();
    expect(
      readPlatformControlSignal({ content: [], detail: { [PLATFORM_CONTROL_KEY]: { kind: "bogus" } } }),
    ).toBeNull();
  });
});
