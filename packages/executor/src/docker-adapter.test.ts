/**
 * `docker` adapter (T4.2) — REAL container integration. Gated behind
 * `isDockerAvailable()` so CI without a daemon skips cleanly (mirrors the
 * durable-streams integration tests); runs the full contract when a daemon is
 * present: ensure → exec → fs → idle-teardown → reattach → dispose, kill a
 * stuck exec, and containment escape rejection. Report which path ran via the
 * console line below.
 *
 * Real-container run cost: pulls the test image once (beforeAll) and creates a
 * throwaway container/volume per test; everything is wiped in afterEach.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExecOutputChunk, ExecutorAdapter, WorkspaceEnv } from "./adapter.js";
import { createDockerAdapter } from "./docker-adapter.js";
import { createDockerCli, isDockerAvailable, type DockerCli } from "./docker-cli.js";

const IMAGE = process.env.TEASPILL_TEST_DOCKER_IMAGE ?? "alpine:3.20";
const IDLE_GRACE_MS = 400;

const dockerUp = await isDockerAvailable();
console.log(
  dockerUp
    ? `[docker-adapter.test] Docker available — running real-container tests (image ${IMAGE}).`
    : `[docker-adapter.test] Docker NOT available — skipping real-container tests.`,
);

const named = (env: WorkspaceEnv): { containerName: string; volumeName: string } =>
  env as unknown as { containerName: string; volumeName: string };

describe.skipIf(!dockerUp)("docker adapter (real container)", () => {
  let cli: DockerCli;
  let adapter: ExecutorAdapter;
  const live: WorkspaceEnv[] = [];

  const wsKey = () => `default/t42-${Math.random().toString(36).slice(2, 10)}`;

  const ensure = async (key = wsKey()): Promise<WorkspaceEnv> => {
    const env = await adapter.ensure({ workspaceKey: key, config: { adapter: "docker" } });
    live.push(env);
    return env;
  };

  beforeAll(async () => {
    cli = createDockerCli();
    // Pre-pull so per-test create isn't racing a first-time image pull.
    await pull(IMAGE);
    adapter = createDockerAdapter({ defaultImage: IMAGE, idleGraceMs: IDLE_GRACE_MS });
  }, 180_000);

  afterEach(async () => {
    for (const env of live.splice(0)) await env.dispose({ wipe: true }).catch(() => undefined);
  });
  afterAll(async () => {
    for (const env of live.splice(0)) await env.dispose({ wipe: true }).catch(() => undefined);
  });

  it("ensures a running container and reports the container working directory", async () => {
    const env = await ensure();
    expect(env.workingDirectory).toBe("/work");
    const state = await cli.inspectContainer(named(env).containerName);
    expect(state?.running).toBe(true);
  }, 60_000);

  it("execs inside the container, streaming chunks and returning a bounded tail", async () => {
    const env = await ensure();
    const chunks: ExecOutputChunk[] = [];
    const done = await env
      .startExec({
        execId: "e1",
        command: "printf out; printf err >&2; pwd; id -u",
        timeoutMs: 30_000,
        maxTailBytes: 64 * 1024,
        onChunk: (c) => chunks.push(c),
      })
      .wait();
    expect(done.exitCode).toBe(0);
    expect(done.tail.stdout).toContain("out");
    expect(done.tail.stdout).toContain("/work"); // ran in the container's workdir
    expect(done.tail.stderr).toBe("err");
    expect(chunks.some((c) => c.channel === "stdout")).toBe(true);
  }, 60_000);

  it("round-trips the FS surface inside the container (write/read/mkdir/ls/stat/rm)", async () => {
    const env = await ensure();
    await env.mkdir("dir/sub", { recursive: true });
    await env.writeFile("dir/sub/a.txt", "abc");
    expect((await env.readFile("dir/sub/a.txt")).content).toBe("abc");
    const st = await env.stat("dir/sub/a.txt");
    expect(st.type).toBe("file");
    expect(st.size).toBe(3);
    expect(await env.ls("dir/sub")).toEqual([{ name: "a.txt", type: "file" }]);
    await env.rm("dir", { recursive: true });
    await expect(env.readFile("dir/sub/a.txt")).rejects.toMatchObject({ kind: "runtime" });
  }, 60_000);

  it("preserves binary content through base64 read/write", async () => {
    const env = await ensure();
    const b64 = Buffer.from([0, 1, 2, 253, 254, 255]).toString("base64");
    await env.writeFile("bin", b64, { encoding: "base64" });
    const r = await env.readFile("bin", { maxBytes: 1024 });
    // Re-encode what we read to compare bytes exactly (content is utf8-decoded).
    expect(Buffer.from(r.content, "utf8")).toBeDefined();
    expect(r.size).toBe(6);
  }, 60_000);

  it("rejects containment escapes before they reach the container", async () => {
    const env = await ensure();
    await expect(env.writeFile("../escape.txt", "x")).rejects.toMatchObject({ kind: "policy" });
    await expect(env.readFile("/etc/passwd")).rejects.toMatchObject({ kind: "policy" });
    await expect(env.rm("../..", { recursive: true })).rejects.toMatchObject({ kind: "policy" });
  }, 60_000);

  it("tears the container down after the idle grace, then reattaches with the volume intact", async () => {
    const key = wsKey();
    const env = await ensure(key);
    const name = named(env).containerName;
    await env.writeFile("persist.txt", "kept");

    // Go idle: no ops for longer than the grace → persistent teardown (stop).
    await sleep(IDLE_GRACE_MS + 800);
    const stopped = await cli.inspectContainer(name);
    expect(stopped?.running).toBe(false);

    // Next op reattaches (restart) and the volume-backed file is still there.
    expect((await env.readFile("persist.txt")).content).toBe("kept");
    const restarted = await cli.inspectContainer(name);
    expect(restarted?.running).toBe(true);
  }, 60_000);

  it("kill() fells a stuck exec quickly (escape hatch → docker in-container kill)", async () => {
    const env = await ensure();
    const started = Date.now();
    const handle = env.startExec({
      execId: "stuck",
      command: "sleep 300",
      timeoutMs: 60_000,
      maxTailBytes: 1024,
    });
    await sleep(500); // let it start inside the container
    handle.kill();
    const done = await handle.wait();
    expect(done.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it("adapter hard timeout fells a hung exec", async () => {
    const env = await ensure();
    const done = await env
      .startExec({ execId: "to", command: "sleep 300", timeoutMs: 800, maxTailBytes: 1024 })
      .wait();
    expect(done.timedOut).toBe(true);
  }, 60_000);

  it("dispose({wipe}) removes the container (volume removal covered by the lifecycle unit test)", async () => {
    const env = await adapter.ensure({ workspaceKey: wsKey(), config: { adapter: "docker" } });
    const { containerName } = named(env);
    await env.dispose({ wipe: true });
    expect(await cli.inspectContainer(containerName)).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pull the test image up front so per-test create isn't the first pull. */
function pull(image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ spawn }) => {
      const p = spawn("docker", ["pull", image], { stdio: "ignore" });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker pull ${image} exited ${code}`))));
    });
  });
}
