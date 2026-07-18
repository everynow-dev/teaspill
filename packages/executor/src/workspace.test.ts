/**
 * 0001:T4.1 workspace virtual object — unit/integration tests against in-memory
 * fakes for the RESTATE layer only (the coordination agent.test.ts pattern):
 * the same handler functions the real `restate.object` wiring calls,
 * exercised on a structural fake context — while the HOST, ADAPTER and
 * PROCESSES are real (ExecutorHost + local adapter + `sh`), so the
 * object↔host↔adapter long-exec protocol runs end to end in-process.
 *
 * Deliberately NOT covered here (live-Restate behaviors, deferred to the
 * conformance kit 0001:T6.3 / failure injection 0001:T9.1 / docker adapter 0001:T4.2):
 * real awakeable resolution through the server (incl. survive-restart,
 * SPIKE §d-4), real `ctx.cancel` + @experimental `explicitCancellation`
 * semantics, replay of a crashed dispatch `ctx.run`, per-handler
 * inactivity/abort timeouts, deployment registration/networking, and the
 * docker adapter. The fakes model the SPIKE-verified behaviors: shared
 * handlers see in-flight K/V writes (§a-2); cancelling the recorded
 * invocation rejects `awaitAwakeable` with `WorkspaceInterruptedError`
 * (§a-3/5); late/double awakeable resolution is ignored (§d-3).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecCompletion } from "./adapter.js";
import { createLocalAdapter } from "./local-adapter.js";
import { ExecutorHost, type AwakeableResolver, type HostStartExecRequest } from "./host.js";
import { createDirectHostClient, type WorkspaceHostClient } from "./host-client.js";
import { InMemoryStreamSink } from "./stream-sink.js";
import {
  WORKSPACE_KV,
  WorkspaceExecTimeoutError,
  WorkspaceInterruptedError,
  type CurrentExecInfo,
  type WorkspaceAwakeable,
  type WorkspaceRuntimeCtx,
  type WorkspaceSharedRuntimeCtx,
} from "./workspace-runtime.js";
import {
  createWorkspaceObject,
  handleDispose,
  handleEnsure,
  handleExec,
  handleFsLs,
  handleFsMkdir,
  handleFsRead,
  handleFsRm,
  handleFsStat,
  handleFsWrite,
  handleKill,
  handleStatus,
  type WorkspaceObjectConfig,
} from "./workspace.js";
import { workspaceExecStdoutStreamPath } from "./keys.js";

const WS_KEY = "default/t41-ws";

// ---------------------------------------------------------------------------
// Fakes (Restate layer only)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolveRaw!: (v: T) => void;
  const d: Partial<Deferred<T>> = { settled: false };
  d.promise = new Promise<T>((res) => {
    resolveRaw = res;
  });
  d.resolve = (v: T) => {
    if (d.settled) return; // double/late resolve ignored (SPIKE §d-3)
    d.settled = true;
    resolveRaw(v);
  };
  return d as Deferred<T>;
}

/** One workspace key's fake world: shared K/V (live-visible to shared ctx), awakeable registry, cancel lever. */
class FakeWorkspaceWorld {
  readonly state = new Map<string, unknown>();
  readonly awakeables = new Map<string, Deferred<unknown>>();
  private readonly running = new Map<string, FakeExclusiveCtx>();
  private awakeableSeq = 0;

  constructor(readonly key: string) {}

  exclusiveCtx(invocationId: string): WorkspaceRuntimeCtx {
    const ctx = new FakeExclusiveCtx(this, invocationId);
    this.running.set(invocationId, ctx);
    return ctx;
  }

  sharedCtx(): WorkspaceSharedRuntimeCtx {
    return {
      key: this.key,
      get: async <T>(name: string): Promise<T | null> =>
        this.state.has(name) ? (this.state.get(name) as T) : null,
      run: async <T>(_name: string, action: () => T | Promise<T>): Promise<T> => action(),
      genericCall: () => {
        throw new Error("genericCall not wired in fake (tests use the direct host client)");
      },
      cancelInvocation: (invocationId: string): void => {
        this.running.get(invocationId)?.triggerInterrupt();
      },
    };
  }

  newAwakeable<T>(): WorkspaceAwakeable<T> {
    const id = `awk-${++this.awakeableSeq}`;
    const d = deferred<unknown>();
    this.awakeables.set(id, d);
    return { id, promise: d.promise as Promise<T> };
  }

  /** The host's AwakeableResolver: resolving an unknown/settled id is a safe no-op (SPIKE §d-3). */
  readonly resolver: AwakeableResolver = async (awakeableId, payload) => {
    this.awakeables.get(awakeableId)?.resolve(payload);
  };

  kv<T>(name: string): T | null {
    return this.state.has(name) ? (this.state.get(name) as T) : null;
  }
}

class FakeExclusiveCtx implements WorkspaceRuntimeCtx {
  readonly key: string;
  private interruptHooks: Array<() => void> = [];
  private interrupted = false;

  constructor(
    private readonly world: FakeWorkspaceWorld,
    readonly invocationId: string,
  ) {
    this.key = world.key;
  }

  async get<T>(name: string): Promise<T | null> {
    return this.world.state.has(name) ? (this.world.state.get(name) as T) : null;
  }
  set<T>(name: string, value: T): void {
    this.world.state.set(name, value);
  }
  clear(name: string): void {
    this.world.state.delete(name);
  }
  async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
    return action();
  }
  genericCall<_REQ, RES>(): Promise<RES> {
    throw new Error("genericCall not wired in fake (tests use the direct host client)");
  }
  awakeable<T>(): WorkspaceAwakeable<T> {
    return this.world.newAwakeable<T>();
  }
  awaitAwakeable<T>(awakeable: WorkspaceAwakeable<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.interrupted) {
        reject(new WorkspaceInterruptedError());
        return;
      }
      const timer = setTimeout(() => reject(new WorkspaceExecTimeoutError()), timeoutMs);
      this.interruptHooks.push(() => {
        clearTimeout(timer);
        reject(new WorkspaceInterruptedError());
      });
      void awakeable.promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err as Error);
        },
      );
    });
  }

  /** Test lever standing in for a real `ctx.cancel` on this invocation (SPIKE §a-3). */
  triggerInterrupt(): void {
    this.interrupted = true;
    for (const hook of this.interruptHooks.splice(0)) hook();
  }
}

// ---------------------------------------------------------------------------
// Harness: real host + real local adapter behind the fake Restate layer
// ---------------------------------------------------------------------------

interface World {
  world: FakeWorkspaceWorld;
  host: ExecutorHost;
  sink: InMemoryStreamSink;
  config: WorkspaceObjectConfig;
}

let base: string;

async function makeWorld(
  overrides: Partial<WorkspaceObjectConfig> = {},
  resolver?: AwakeableResolver,
): Promise<World> {
  const world = new FakeWorkspaceWorld(WS_KEY);
  const sink = new InMemoryStreamSink();
  const host = new ExecutorHost({
    adapters: { local: createLocalAdapter({ baseDir: base, quiet: true }) },
    streamSink: sink,
    resolveAwakeable: resolver ?? world.resolver,
    resolveRetries: 0,
  });
  const config: WorkspaceObjectConfig = { host: createDirectHostClient(host), ...overrides };
  return { world, host, sink, config };
}

async function ensured(w: World): Promise<void> {
  await handleEnsure(w.world.exclusiveCtx("inv-ensure"), w.config, {
    config: { adapter: "local" },
  });
}

const poll = async (cond: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("poll timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "teaspill-ws-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ensure
// ---------------------------------------------------------------------------

describe("handleEnsure", () => {
  it("creates the environment, records config + ready status, and reattaches idempotently", async () => {
    const w = await makeWorld();
    const first = await handleEnsure(w.world.exclusiveCtx("i1"), w.config, {
      config: { adapter: "local" },
    });
    expect(first.reattached).toBe(false);
    expect(first.adapter).toBe("local");
    expect(first.readContainment).toBe("workspace");
    expect(first.workingDirectory).toBe(join(base, "default", "t41-ws"));
    expect(w.world.kv(WORKSPACE_KV.status)).toBe("ready");

    const second = await handleEnsure(w.world.exclusiveCtx("i2"), w.config, {
      config: { adapter: "local" },
    });
    expect(second.reattached).toBe(true);
    expect(second.workingDirectory).toBe(first.workingDirectory);
  });

  it("rejects switching adapters after binding (0001:D4: no mid-session switching)", async () => {
    const w = await makeWorld();
    await ensured(w);
    await expect(
      handleEnsure(w.world.exclusiveCtx("i2"), w.config, { config: { adapter: "docker" } }),
    ).rejects.toThrow(/bound to adapter "local"/);
  });

  it("rejects unknown adapters (host has no such adapter registered)", async () => {
    const w = await makeWorld();
    await expect(
      handleEnsure(w.world.exclusiveCtx("i1"), w.config, { config: { adapter: "docker" } }),
    ).rejects.toThrow(/no adapter named "docker"/);
  });
});

// ---------------------------------------------------------------------------
// exec — the long-exec awakeable protocol, end to end
// ---------------------------------------------------------------------------

describe("handleExec", () => {
  it("runs the full protocol: dispatch → host resolves the awakeable → {exitCode, tailBytes, streamRef}, stdout out-of-band", async () => {
    const w = await makeWorld();
    await ensured(w);

    const result = await handleExec(w.world.exclusiveCtx("inv-exec-1"), w.config, {
      command: "printf hello-stream; printf oops >&2",
      execId: "e-one",
    });

    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.tailBytes.stdout).toBe("hello-stream");
    expect(result.tailBytes.stderr).toBe("oops");
    const expectedStream = workspaceExecStdoutStreamPath(WS_KEY, "e-one");
    expect(result.streamRef).toBe(expectedStream);
    // Out-of-band: full output landed on the per-exec durable stream (sink), not the journal.
    expect(w.sink.text(expectedStream, "stdout")).toBe("hello-stream");
    expect(w.sink.text(expectedStream, "stderr")).toBe("oops");
    // K/V cleaned up after the wake.
    expect(w.world.kv(WORKSPACE_KV.currentExec)).toBe(null);
    expect(w.world.kv(WORKSPACE_KV.currentInvocationId)).toBe(null);
  });

  it("derives a replay-stable execId from the invocation id when none is supplied", async () => {
    const w = await makeWorld();
    await ensured(w);
    const result = await handleExec(w.world.exclusiveCtx("inv_1ABC-def"), w.config, {
      command: "true",
    });
    expect(result.execId).toBe("x-inv_1abc-def");
    expect(result.streamRef).toBe(workspaceExecStdoutStreamPath(WS_KEY, "x-inv_1abc-def"));
  });

  it("adapter-level timeout kills the process tree → outcome timeout (timeoutKind exec)", async () => {
    const w = await makeWorld();
    await ensured(w);
    const result = await handleExec(w.world.exclusiveCtx("inv-timeout"), w.config, {
      command: "sleep 30 & wait",
      timeoutMs: 150,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.timeoutKind).toBe("exec");
    expect(result.exitCode).toBe(null);
  }, 10_000);

  it("awakeable backstop fires when the host never resolves (dead host) → timeout (host-unresponsive) + durable kill", async () => {
    // Resolver that drops every resolution = a host that dies before resolving.
    const dropResolver: AwakeableResolver = async () => undefined;
    const w = await makeWorld({ awakeableGraceMs: 100 }, dropResolver);
    await ensured(w);
    const result = await handleExec(w.world.exclusiveCtx("inv-dead-host"), w.config, {
      command: "sleep 30",
      execId: "e-dead",
      timeoutMs: 100, // awakeable backstop = 100 + 100 grace
    });
    expect(result.outcome).toBe("timeout");
    expect(result.timeoutKind).toBe("host-unresponsive");
    // The durable cleanup kill reached the host (exec record now completed-by-kill).
    const killAgain = await w.host.killExec({
      ref: { workspaceKey: WS_KEY, config: { adapter: "local" } },
      execId: "e-dead",
    });
    await poll(() => killAgain !== undefined);
    expect(killAgain.state).not.toBe("running");
  }, 10_000);

  it("rejects exec before ensure (terminal, not retryable)", async () => {
    const w = await makeWorld();
    await expect(
      handleExec(w.world.exclusiveCtx("inv-x"), w.config, { command: "true" }),
    ).rejects.toThrow(/not ensured/);
  });

  it("caps tail bytes and timeout at the configured limits (0001:R4)", async () => {
    const w = await makeWorld({ maxTailBytesCap: 64 });
    await ensured(w);
    const result = await handleExec(w.world.exclusiveCtx("inv-cap"), w.config, {
      command: `for i in $(seq 1 200); do echo chunk-$i; done`,
      maxTailBytes: 10_000_000, // clamped to 64
    });
    expect(result.tailBytes.stdout.length).toBeLessThanOrEqual(64);
    expect(result.tailBytes.truncated).toBe(true);
    expect(result.tailBytes.stdout).toContain("chunk-200");
  });
});

// ---------------------------------------------------------------------------
// kill — the shared escape hatch (anticipate-a)
// ---------------------------------------------------------------------------

describe("handleKill (shared escape hatch)", () => {
  it("aborts a stuck exec WITHOUT queueing behind it: host kill → awakeable resolves killed", async () => {
    const w = await makeWorld();
    await ensured(w);

    // Start a stuck exec on the exclusive lane (unawaited — it blocks "the workspace").
    const execPromise = handleExec(w.world.exclusiveCtx("inv-stuck"), w.config, {
      command: "echo started; sleep 60",
      execId: "e-stuck",
      timeoutMs: 60_000,
    });
    // Wait until the process is live (its first chunk hit the stream).
    const streamPath = workspaceExecStdoutStreamPath(WS_KEY, "e-stuck");
    await poll(() => w.sink.text(streamPath, "stdout").includes("started"));
    // Shared handler sees the in-flight exec via live K/V (SPIKE §a-2).
    const shared = w.world.sharedCtx();
    expect((await handleStatus(shared)).currentExec?.execId).toBe("e-stuck");

    const kill = await handleKill(shared, w.config, {});
    expect(kill).toMatchObject({
      killed: true,
      execId: "e-stuck",
      hostKilled: true,
      invocationCancelled: false,
    });

    // The blocked exclusive exec unblocks with a KILLED completion (protocol, not cancel).
    const result = await execPromise;
    expect(result.outcome).toBe("killed");
    expect(result.exitCode).toBe(null);
    expect(result.signal).toBe("SIGTERM");
    expect(result.tailBytes.stdout).toContain("started");
  }, 15_000);

  it("force: also cancels the in-flight invocation (dead-host unwedge) — durable cleanup still runs (0001:A4)", async () => {
    // Host client whose startExec dispatches into a black hole and records kills:
    // models a host that accepted the exec but will never resolve the awakeable.
    const kills: string[] = [];
    const blackHoleHost: WorkspaceHostClient = {
      ensure: async () => ({
        adapter: "local",
        workingDirectory: "/dev/null",
        readContainment: "workspace",
      }),
      startExec: async (_ctx, req: HostStartExecRequest) => {
        void req;
        return { accepted: true, deduped: false };
      },
      killExec: async (_ctx, req) => {
        kills.push(req.execId);
        return { killed: false, state: "unknown" };
      },
      fs: async () => ({ ok: false, error: { kind: "unavailable", message: "black hole" } }),
      dispose: async () => undefined,
    };
    const w = await makeWorld({ host: blackHoleHost });
    await ensured(w);

    const execPromise = handleExec(w.world.exclusiveCtx("inv-wedged"), w.config, {
      command: "whatever",
      execId: "e-wedged",
      timeoutMs: 60_000,
    });
    const shared = w.world.sharedCtx();
    await poll(() => w.world.kv<CurrentExecInfo>(WORKSPACE_KV.currentExec)?.execId === "e-wedged");

    const kill = await handleKill(shared, w.config, { force: true });
    expect(kill).toMatchObject({ killed: true, execId: "e-wedged", invocationCancelled: true });

    // explicitCancellation semantics (modeled): post-cancel durable steps work —
    // the handler killed on the host and returned a structured result.
    const result = await execPromise;
    expect(result.outcome).toBe("killed");
    expect(kills).toContain("e-wedged");
  });

  it("no exec in flight / id mismatch / not ensured are structured no-ops", async () => {
    const w = await makeWorld();
    expect(await handleKill(w.world.sharedCtx(), w.config, {})).toEqual({
      killed: false,
      reason: "not-ensured",
    });
    await ensured(w);
    expect(await handleKill(w.world.sharedCtx(), w.config, {})).toEqual({
      killed: false,
      reason: "no-exec-in-flight",
    });

    const execPromise = handleExec(w.world.exclusiveCtx("inv-a"), w.config, {
      command: "echo go; sleep 60",
      execId: "e-a",
      timeoutMs: 60_000,
    });
    await poll(() => w.world.kv<CurrentExecInfo>(WORKSPACE_KV.currentExec) !== null);
    expect(await handleKill(w.world.sharedCtx(), w.config, { execId: "e-other" })).toEqual({
      killed: false,
      reason: "exec-id-mismatch",
      currentExecId: "e-a",
    });
    // Clean up the real process.
    expect((await handleKill(w.world.sharedCtx(), w.config, { execId: "e-a" })).killed).toBe(true);
    await execPromise;
  }, 15_000);
});

// ---------------------------------------------------------------------------
// fs surface
// ---------------------------------------------------------------------------

describe("fs handlers", () => {
  it("write → read/stat/ls → rm round-trip through object → host → adapter", async () => {
    const w = await makeWorld();
    await ensured(w);
    const ctx = (): WorkspaceRuntimeCtx => w.world.exclusiveCtx(`inv-fs-${Math.random()}`);

    await handleFsMkdir(ctx(), w.config, { path: "src/deep", recursive: true });
    await handleFsWrite(ctx(), w.config, { path: "src/deep/a.txt", content: "abc" });
    expect((await handleFsRead(ctx(), w.config, { path: "src/deep/a.txt" })).content).toBe("abc");
    expect((await handleFsStat(ctx(), w.config, { path: "src/deep/a.txt" })).size).toBe(3);
    expect(await handleFsLs(ctx(), w.config, { path: "src/deep" })).toEqual([
      { name: "a.txt", type: "file" },
    ]);
    await handleFsRm(ctx(), w.config, { path: "src", recursive: true });
    await expect(handleFsRead(ctx(), w.config, { path: "src/deep/a.txt" })).rejects.toThrow(
      /\[runtime\]/,
    );
  });

  it("containment violations surface as terminal [policy] errors (writes contained everywhere)", async () => {
    const w = await makeWorld();
    await ensured(w);
    const ctx = w.world.exclusiveCtx("inv-fs-escape");
    await expect(
      handleFsWrite(ctx, w.config, { path: "../escape.txt", content: "x" }),
    ).rejects.toThrow(/\[policy\]/);
    await expect(
      handleFsRead(w.world.exclusiveCtx("inv-fs-escape2"), w.config, { path: "/etc/passwd" }),
    ).rejects.toThrow(/\[policy\]/);
  });

  it("base64 write for binary content; read budget clamped by config", async () => {
    const w = await makeWorld({ maxFsReadBytesCap: 8 });
    await ensured(w);
    await handleFsWrite(w.world.exclusiveCtx("i1"), w.config, {
      path: "bin.dat",
      content: Buffer.from("0123456789").toString("base64"),
      encoding: "base64",
    });
    const read = await handleFsRead(w.world.exclusiveCtx("i2"), w.config, {
      path: "bin.dat",
      maxBytes: 1000,
    });
    expect(read.truncated).toBe(true); // clamped to the 8-byte cap
    expect(read.content).toBe("01234567");
    expect(read.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// status / dispose / lifecycle
// ---------------------------------------------------------------------------

describe("status + dispose", () => {
  it("status: uninitialized → ready (+adapter) → disposed; exec after dispose rejects; re-ensure rebinds", async () => {
    const w = await makeWorld();
    const shared = w.world.sharedCtx();
    expect((await handleStatus(shared)).status).toBe("uninitialized");

    await ensured(w);
    expect(await handleStatus(shared)).toMatchObject({
      status: "ready",
      adapter: "local",
      workspaceKey: WS_KEY,
    });

    const disposed = await handleDispose(w.world.exclusiveCtx("inv-d"), w.config, {});
    expect(disposed).toEqual({ disposed: true, wiped: false });
    expect((await handleStatus(shared)).status).toBe("disposed");
    await expect(
      handleExec(w.world.exclusiveCtx("inv-e"), w.config, { command: "true" }),
    ).rejects.toThrow(/not ensured/);
    // Dispose is idempotent; re-ensure starts a fresh binding (even a different adapter would be legal now).
    expect(await handleDispose(w.world.exclusiveCtx("inv-d2"), w.config, {})).toEqual({
      disposed: false,
      wiped: false,
    });
    const re = await handleEnsure(w.world.exclusiveCtx("inv-r"), w.config, {
      config: { adapter: "local" },
    });
    expect(re.reattached).toBe(false);
    expect((await handleStatus(shared)).status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// host-level idempotence (the at-least-once dispatch edge)
// ---------------------------------------------------------------------------

describe("ExecutorHost dedup + late resolution", () => {
  it("re-dispatch of a known execId is a no-op (single process), and a completed re-dispatch re-resolves safely", async () => {
    const w = await makeWorld();
    const ref = { workspaceKey: WS_KEY, config: { adapter: "local" } };
    await w.host.ensure(ref);
    const awk = w.world.newAwakeable<ExecCompletion>();
    const streamPath = workspaceExecStdoutStreamPath(WS_KEY, "e-dedup");
    const req: HostStartExecRequest = {
      ref,
      execId: "e-dedup",
      command: "echo once",
      timeoutMs: 10_000,
      maxTailBytes: 1024,
      awakeableId: awk.id,
      streamPath,
    };
    expect((await w.host.startExec(req)).deduped).toBe(false);
    expect((await w.host.startExec(req)).deduped).toBe(true); // retried dispatch — no second process

    const completion = await awk.promise;
    expect(completion.exitCode).toBe(0);
    expect(w.sink.text(streamPath, "stdout")).toBe("once\n"); // exactly one execution

    // Re-dispatch AFTER completion: re-resolves the (settled) awakeable — ignored, still no re-execution.
    expect((await w.host.startExec(req)).deduped).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.sink.text(streamPath, "stdout")).toBe("once\n");
  });

  it("kill of unknown/completed execs is a structured no-op", async () => {
    const w = await makeWorld();
    const ref = { workspaceKey: WS_KEY, config: { adapter: "local" } };
    await w.host.ensure(ref);
    expect(await w.host.killExec({ ref, execId: "nope" })).toEqual({
      killed: false,
      state: "unknown",
    });
  });
});

// ---------------------------------------------------------------------------
// Restate wiring smoke (definition builds; live behavior is 0001:T6.3/0001:T9.1)
// ---------------------------------------------------------------------------

describe("createWorkspaceObject", () => {
  it("builds the `workspace` virtual object definition with all handlers", async () => {
    const w = await makeWorld();
    const object = createWorkspaceObject(w.config);
    expect(object.name).toBe("workspace");
  });
});
