/**
 * Docker adapter LIFECYCLE STATE MACHINE (0001:T4.2) — unit-tested against a fake
 * DockerCli with fake timers, so the idle-timer / grace / reattach logic is
 * fully covered WITHOUT a Docker daemon (the real-container behaviors live in
 * docker-adapter.test.ts, gated on daemon availability). This is the "unit-test
 * the state machine with a fake docker client" deliverable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecCompletion, ExecHandle } from "./adapter.js";
import { createDockerAdapter } from "./docker-adapter.js";
import { DockerNameConflictError, type DockerCli, type DockerExecOpts } from "./docker-cli.js";

const WS_KEY = "default/t42-docker-fake";

// ---------------------------------------------------------------------------
// Fake DockerCli (records the control-plane call sequence; execs are manually
// completable so a test can hold the workspace "warm" for as long as it likes).
// ---------------------------------------------------------------------------

interface PendingExec {
  opts: DockerExecOpts;
  resolve: (c: ExecCompletion) => void;
  killed: boolean;
}

class FakeDockerCli implements DockerCli {
  readonly calls: string[] = [];
  readonly containers = new Map<string, { running: boolean }>();
  readonly volumes = new Set<string>();
  readonly pending = new Map<string, PendingExec>();
  /** Injectable runExec result (FS probes). Default: exit 0, empty. */
  runExecImpl: (name: string, cmd: readonly string[]) => Promise<{
    exitCode: number | null;
    stdout: Buffer;
    stderr: Buffer;
  }> = async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });

  async ping(): Promise<void> {
    this.calls.push("ping");
  }
  async inspectContainer(name: string): Promise<{ running: boolean } | null> {
    return this.containers.get(name) ?? null;
  }
  async ensureVolume(name: string): Promise<void> {
    this.calls.push("ensureVolume");
    this.volumes.add(name);
  }
  async removeVolume(name: string): Promise<void> {
    this.calls.push("removeVolume");
    this.volumes.delete(name);
  }
  async createContainer(spec: { name: string }): Promise<void> {
    this.calls.push("createContainer");
    if (this.containers.has(spec.name)) throw new DockerNameConflictError(spec.name);
    this.containers.set(spec.name, { running: true });
  }
  async startContainer(name: string): Promise<void> {
    this.calls.push("startContainer");
    this.containers.set(name, { running: true });
  }
  async stopContainer(name: string): Promise<void> {
    this.calls.push("stopContainer");
    const c = this.containers.get(name);
    if (c) c.running = false;
  }
  async removeContainer(name: string): Promise<void> {
    this.calls.push("removeContainer");
    this.containers.delete(name);
  }
  startExec(_name: string, opts: DockerExecOpts): ExecHandle {
    this.calls.push("startExec");
    let resolve!: (c: ExecCompletion) => void;
    const completion = new Promise<ExecCompletion>((r) => (resolve = r));
    const rec: PendingExec = { opts, resolve, killed: false };
    this.pending.set(opts.execId, rec);
    return {
      execId: opts.execId,
      wait: () => completion,
      kill: () => {
        rec.killed = true;
        resolve(completionFor({ killed: true }));
      },
    };
  }
  async runExec(
    name: string,
    cmd: readonly string[],
  ): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
    return this.runExecImpl(name, cmd);
  }

  completeExec(execId: string, partial: Partial<ExecCompletion> = {}): void {
    const rec = this.pending.get(execId);
    if (!rec) throw new Error(`no pending exec ${execId}`);
    rec.resolve(completionFor(partial));
  }
}

function completionFor(partial: Partial<ExecCompletion>): ExecCompletion {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    killed: false,
    tail: { stdout: "", stderr: "", truncated: false },
    durationMs: 1,
    ...partial,
  };
}

/** Let queued microtasks (mutex chain, ensureUp) settle without advancing time. */
const flush = () => vi.advanceTimersByTimeAsync(0);

// ---------------------------------------------------------------------------

describe("docker adapter lifecycle state machine (fake cli)", () => {
  let fake: FakeDockerCli;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = new FakeDockerCli();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeAdapter = (opts?: { persistent?: boolean; idleGraceMs?: number }) =>
    createDockerAdapter({
      cli: fake,
      idleGraceMs: opts?.idleGraceMs ?? 1000,
      persistentByDefault: opts?.persistent ?? true,
    });

  it("ensure() creates the volume + container (id-from-key) and arms the idle timer", async () => {
    const adapter = makeAdapter();
    const env = await adapter.ensure({ workspaceKey: WS_KEY, config: { adapter: "docker" } });
    expect(fake.calls).toEqual(["ping", "ensureVolume", "createContainer"]);
    expect(fake.containers.size).toBe(1);
    expect(env.workingDirectory).toBe("/work");
    // Same key ⇒ same deterministic container/volume names (host-restart reattach).
    const env2 = await adapter.ensure({ workspaceKey: WS_KEY, config: { adapter: "docker" } });
    expect((env2 as unknown as { containerName: string }).containerName).toBe(
      (env as unknown as { containerName: string }).containerName,
    );
  });

  it("STOPS the container (persistent) after the idle grace, and REATTACHES on the next exec", async () => {
    const env = await makeAdapter({ persistent: true, idleGraceMs: 1000 }).ensure({
      workspaceKey: WS_KEY,
      config: { adapter: "docker" },
    });
    fake.calls.length = 0;

    // Idle window elapses → stop (writable layer preserved, not removed).
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toEqual(["stopContainer"]);
    expect(fake.containers.get([...fake.containers.keys()][0]!)!.running).toBe(false);

    // A new exec reattaches: inspect sees stopped → startContainer (no recreate).
    fake.calls.length = 0;
    const handle = env.startExec({ execId: "e1", command: "true", timeoutMs: 1000, maxTailBytes: 64 });
    await flush();
    expect(fake.calls).toEqual(["startContainer", "startExec"]);
    fake.completeExec("e1");
    await handle.wait();
  });

  it("REMOVES the container (ephemeral) after idle, and RECREATES on the next op", async () => {
    const env = await makeAdapter({ persistent: false, idleGraceMs: 1000 }).ensure({
      workspaceKey: WS_KEY,
      config: { adapter: "docker" },
    });
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toEqual(["removeContainer"]);
    expect(fake.containers.size).toBe(0);

    // Volume survived the container removal → recreate reuses it (persistence).
    expect(fake.volumes.size).toBe(1);
    fake.calls.length = 0;
    await env.stat("x").catch(() => undefined); // any op triggers ensureUp
    expect(fake.calls.slice(0, 2)).toEqual(["ensureVolume", "createContainer"]);
  });

  it("a new op DURING the grace cancels the teardown (reattach, no stop/remove)", async () => {
    const env = await makeAdapter({ idleGraceMs: 1000 }).ensure({
      workspaceKey: WS_KEY,
      config: { adapter: "docker" },
    });
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(500); // half the grace
    const handle = env.startExec({ execId: "e1", command: "true", timeoutMs: 1000, maxTailBytes: 64 });
    await flush();
    // Container was still running → no start/stop, just the exec.
    expect(fake.calls).toEqual(["startExec"]);
    // Advancing past the ORIGINAL deadline must NOT tear down (op in flight).
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toEqual(["startExec"]);
    fake.completeExec("e1");
    await handle.wait();
  });

  it("keeps the container warm while an exec is in flight, arming idle only on completion", async () => {
    const env = await makeAdapter({ idleGraceMs: 1000 }).ensure({
      workspaceKey: WS_KEY,
      config: { adapter: "docker" },
    });
    const handle = env.startExec({ execId: "e1", command: "sleep", timeoutMs: 5000, maxTailBytes: 64 });
    await flush();
    fake.calls.length = 0;
    // Long exec running: advancing well past the grace must not tear down.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.calls).toEqual([]);
    fake.completeExec("e1");
    await handle.wait();
    // Now quiet → grace arms → teardown.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toEqual(["stopContainer"]);
  });

  it("dispose({wipe}) removes the container AND volume; plain dispose stops (preserves)", async () => {
    const adapter = makeAdapter();
    const env = await adapter.ensure({ workspaceKey: WS_KEY, config: { adapter: "docker" } });
    fake.calls.length = 0;
    await env.dispose({ wipe: true });
    expect(fake.calls).toEqual(["removeContainer", "removeVolume"]);
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.size).toBe(0);

    const fake2 = new FakeDockerCli();
    const env2 = await createDockerAdapter({ cli: fake2, idleGraceMs: 1000 }).ensure({
      workspaceKey: WS_KEY,
      config: { adapter: "docker" },
    });
    fake2.calls.length = 0;
    await env2.dispose();
    expect(fake2.calls).toEqual(["stopContainer"]); // preserved, volume untouched
    expect(fake2.volumes.size).toBe(1);
  });

  it("kill on an in-flight exec resolves killed and still arms idle afterward", async () => {
    const env = await makeAdapter({ idleGraceMs: 1000 }).ensure({
      workspaceKey: WS_KEY,
      config: { adapter: "docker" },
    });
    const handle = env.startExec({ execId: "e1", command: "sleep", timeoutMs: 5000, maxTailBytes: 64 });
    await flush();
    handle.kill();
    const done = await handle.wait();
    expect(done.killed).toBe(true);
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toEqual(["stopContainer"]); // quiet again after the killed exec
  });

  it("a lost create race (name conflict) degrades to reattach", async () => {
    const adapter = makeAdapter();
    const env = await adapter.ensure({ workspaceKey: WS_KEY, config: { adapter: "docker" } });
    const name = (env as unknown as { containerName: string }).containerName;

    // Simulate the container vanishing between wakes, and a sibling lease
    // winning the recreate race: ensureUp sees absent → create → conflict →
    // reattach (startContainer) to the sibling's container.
    fake.containers.delete(name);
    fake.createContainer = async (spec) => {
      fake.calls.push("createContainer");
      fake.containers.set(spec.name, { running: true }); // sibling won the race
      throw new DockerNameConflictError(spec.name);
    };
    fake.calls.length = 0;
    await env.stat("x").catch(() => undefined);
    expect(fake.calls).toContain("createContainer");
    expect(fake.calls).toContain("startContainer"); // reattached to the sibling's container
  });
});
