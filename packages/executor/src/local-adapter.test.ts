/**
 * Dev-only `local` adapter (T4.1) — real processes, real filesystem: the
 * behaviors a fake can't honestly cover (kill-tree, symlink containment).
 */

import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecOutputChunk, ExecutorAdapter, WorkspaceEnv } from "./adapter.js";
import { WorkspaceError } from "./errors.js";
import { createLocalAdapter } from "./local-adapter.js";

const WS_KEY = "default/t41-local";

describe("local adapter", () => {
  let base: string;
  let adapter: ExecutorAdapter;
  let env: WorkspaceEnv;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "teaspill-local-"));
    adapter = createLocalAdapter({ baseDir: base, quiet: true });
    env = await adapter.ensure({ workspaceKey: WS_KEY, config: { adapter: "local" } });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const exec = (command: string, opts: Partial<Parameters<WorkspaceEnv["startExec"]>[0]> = {}) =>
    env.startExec({ execId: "e1", command, timeoutMs: 10_000, maxTailBytes: 64 * 1024, ...opts });

  it("creates the per-workspace root from the key alone (<base>/<tenant>/<name>) and reattaches", async () => {
    expect(env.workingDirectory).toBe(join(base, "default", "t41-local"));
    expect((await stat(env.workingDirectory)).isDirectory()).toBe(true);
    const again = await adapter.ensure({ workspaceKey: WS_KEY, config: { adapter: "local" } });
    expect(again.workingDirectory).toBe(env.workingDirectory); // deterministic identity — host-restart reattach
  });

  it("runs a command, captures exit code and per-channel tails, cwd = workspace root", async () => {
    const done = await exec(`printf out; printf err >&2; pwd`).wait();
    expect(done.exitCode).toBe(0);
    expect(done.timedOut).toBe(false);
    expect(done.killed).toBe(false);
    expect(done.tail.stdout).toContain("out");
    expect(done.tail.stderr).toBe("err");
    expect(done.tail.stdout.trim().endsWith("t41-local")).toBe(true);
  });

  it("propagates non-zero exit codes and stdin", async () => {
    expect((await exec("exit 7").wait()).exitCode).toBe(7);
    const cat = await exec("cat", { stdin: "hello-stdin" }).wait();
    expect(cat.tail.stdout).toBe("hello-stdin");
  });

  it("keeps the LAST maxTailBytes bytes (tail semantics — errors live at the end)", async () => {
    const done = await exec(`for i in $(seq 1 500); do echo "line-$i"; done`, {
      maxTailBytes: 128,
    }).wait();
    expect(done.tail.truncated).toBe(true);
    expect(done.tail.stdout.length).toBeLessThanOrEqual(128);
    expect(done.tail.stdout).toContain("line-500"); // end preserved
    expect(done.tail.stdout).not.toContain("line-1\n"); // start dropped
  });

  it("streams chunks via onChunk, and a throwing consumer never affects the exec", async () => {
    const chunks: ExecOutputChunk[] = [];
    const done = await exec("echo a; echo b >&2", {
      onChunk: (c) => {
        chunks.push(c);
        throw new Error("consumer bug");
      },
    }).wait();
    expect(done.exitCode).toBe(0);
    expect(chunks.some((c) => c.channel === "stdout" && c.text.includes("a"))).toBe(true);
    expect(chunks.some((c) => c.channel === "stderr" && c.text.includes("b"))).toBe(true);
  });

  it("enforces the hard timeout across the whole process TREE (sh + grandchildren)", async () => {
    const started = Date.now();
    // `sleep 30 & wait` leaves a grandchild holding the pipes — the kill must
    // signal the process group or wait() hangs until the sleep ends.
    const done = await exec("sleep 30 & wait", { timeoutMs: 150 }).wait();
    expect(done.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("kill() terminates a running exec (killed: true, SIGTERM escalation)", async () => {
    const handle = exec("sleep 30");
    setTimeout(() => handle.kill(), 100);
    const done = await handle.wait();
    expect(done.killed).toBe(true);
    expect(done.exitCode).toBe(null);
    expect(done.signal).toBe("SIGTERM");
  }, 10_000);

  it("contains fs writes/reads (realpath walk) — escapes reject with policy", async () => {
    await env.writeFile("notes/../ok.txt", "fine"); // stays inside
    expect((await env.readFile("ok.txt")).content).toBe("fine");

    await expect(env.writeFile("../escape.txt", "x")).rejects.toMatchObject({ kind: "policy" });
    await expect(env.readFile("/etc/passwd")).rejects.toMatchObject({ kind: "policy" });
    await expect(env.rm("../..", { recursive: true })).rejects.toMatchObject({ kind: "policy" });

    // Symlink escape through a directory component.
    await writeFile(join(base, "secret.txt"), "s");
    await symlink(base, join(env.workingDirectory, "up"));
    await expect(env.readFile("up/secret.txt")).rejects.toMatchObject({ kind: "policy" });
  });

  it("fs surface round-trips: write → read/stat/ls → rm; missing paths are runtime errors", async () => {
    await env.mkdir("dir/sub", { recursive: true });
    await env.writeFile("dir/sub/a.txt", "abc");
    expect((await env.readFile("dir/sub/a.txt")).content).toBe("abc");
    expect((await env.stat("dir/sub/a.txt")).size).toBe(3);
    expect(await env.ls("dir/sub")).toEqual([{ name: "a.txt", type: "file" }]);
    await env.rm("dir", { recursive: true });
    await expect(env.readFile("dir/sub/a.txt")).rejects.toMatchObject({ kind: "runtime" });
    await expect(env.rm(".")).rejects.toMatchObject({ kind: "policy" }); // never rm the root itself
  });

  it("readFile truncates at the byte budget and reports the real size", async () => {
    await env.writeFile("big.txt", "x".repeat(1000));
    const r = await env.readFile("big.txt", { maxBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(100);
    expect(r.size).toBe(1000);
  });

  it("dispose kills running execs; wipe removes the directory", async () => {
    const handle = env.startExec({
      execId: "e-linger",
      command: "sleep 30",
      timeoutMs: 60_000,
      maxTailBytes: 1024,
    });
    await new Promise((r) => setTimeout(r, 100));
    await env.dispose({ wipe: true });
    const done = await handle.wait();
    expect(done.killed).toBe(true);
    await expect(stat(env.workingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("rejects malformed workspace keys (no traversal via the key)", async () => {
    await expect(
      adapter.ensure({ workspaceKey: "default/../evil", config: { adapter: "local" } }),
    ).rejects.toThrow(/invalid workspace|invalid/);
    await expect(
      adapter.ensure({ workspaceKey: "noslash", config: { adapter: "local" } }),
    ).rejects.toThrow();
  });

  it("declares workspace read containment (the per-adapter read stance, anticipate-b)", () => {
    expect(adapter.readContainment).toBe("workspace");
  });

  it("exec cwd must stay inside the root", () => {
    expect(() => exec("pwd", { cwd: "../.." })).toThrowError(WorkspaceError);
  });
});
