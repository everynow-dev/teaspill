/**
 * The concrete ingress `WorkspaceClient` (0002:T4.1) against a fake fetch:
 * dispatch shapes, replay-stable derived exec ids / idempotency keys,
 * ensure-on-first-use memoization, fs mapping, and — the 0002:T3.1 seam —
 * abort→kill via `linkExecAbortToKill` (at-most-once, already-aborted skips
 * dispatch, abort-after-completion is a no-op).
 */

import { describe, expect, it } from "vitest";
import { createIngressWorkspaceClient, deriveExecId } from "./workspace-client.js";

interface Captured {
  url: string;
  handler: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeIngress(
  respond: (handler: string, body: Record<string, unknown>) => unknown = () => ({}),
) {
  const calls: Captured[] = [];
  const gate = new Map<string, (v: unknown) => void>();
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const handler = url.split("/").pop()!;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, handler, headers, body });
    const pending = gate.get(handler);
    if (pending) {
      // Block this handler until the test releases it (in-flight exec).
      return new Promise((resolve) => {
        gate.set(handler, (v) =>
          resolve(new Response(JSON.stringify(v ?? respond(handler, body)), { status: 200 })),
        );
      });
    }
    return new Response(JSON.stringify(respond(handler, body) ?? {}), { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    holdNext(handler: string): void {
      gate.set(handler, () => {});
    },
    release(handler: string, value: unknown): void {
      const fn = gate.get(handler);
      gate.delete(handler);
      fn?.(value);
    },
  };
}

const execResult = (over: Record<string, unknown> = {}) => ({
  execId: "k1",
  outcome: "completed",
  exitCode: 0,
  signal: null,
  tailBytes: { stdout: "out", stderr: "", truncated: false },
  streamRef: "/t/default/workspaces/w/exec/k1/stdout",
  durationMs: 5,
  ...over,
});

function client(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return createIngressWorkspaceClient({
    ingressUrl: "http://restate:8080",
    workspaceRef: "default/w-1",
    idempotencyKey: "KEY",
    fetch: fetchImpl,
    ensureCache: new Map(), // fresh per test — never the process-wide memo
    ...over,
  });
}

describe("createIngressWorkspaceClient — dispatch", () => {
  it("execs ensure-then-exec with a derived exec id and a derived idempotency key", async () => {
    const ing = fakeIngress((h) => (h === "exec" ? execResult() : {}));
    const ws = client(ing.fetchImpl);
    const res = await ws.exec("echo hi", { timeoutMs: 1234 });

    expect(ing.calls.map((c) => c.handler)).toEqual(["ensure", "exec"]);
    const exec = ing.calls[1]!;
    expect(exec.url).toBe(`http://restate:8080/workspace/${encodeURIComponent("default/w-1")}/exec`);
    expect(exec.body["command"]).toBe("echo hi");
    expect(exec.body["timeoutMs"]).toBe(1234);
    expect(exec.headers["idempotency-key"]).toBe("KEY#w0");
    expect(exec.body["execId"]).toBe(deriveExecId("KEY#w0")); // replay-stable derivation
    expect(res).toEqual({ exitCode: 0, tail: "out", streamRef: execResult().streamRef });
  });

  it("side-effecting ops get DISTINCT derived keys; reads carry none; ensure is memoized", async () => {
    const ing = fakeIngress((h) =>
      h === "fsRead"
        ? { content: "data", encoding: "utf8", size: 4, truncated: false }
        : h === "fsLs"
          ? [{ name: "a", type: "file" }, { name: "d", type: "directory" }]
          : {},
    );
    const ws = client(ing.fetchImpl);
    await ws.writeFile("f.txt", "x");
    await ws.mkdir("dir");
    expect(await ws.readFile("f.txt")).toBe("data");
    expect(await ws.ls(".")).toEqual(["a", "d"]);

    expect(ing.calls.map((c) => c.handler)).toEqual(["ensure", "fsWrite", "fsMkdir", "fsRead", "fsLs"]);
    expect(ing.calls[1]!.headers["idempotency-key"]).toBe("KEY#w0");
    expect(ing.calls[2]!.headers["idempotency-key"]).toBe("KEY#w1");
    expect(ing.calls[3]!.headers["idempotency-key"]).toBeUndefined();
    expect(ing.calls[4]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("maps fsStat types onto the frozen kind union and decodes base64 reads", async () => {
    const ing = fakeIngress((h) =>
      h === "fsStat"
        ? { type: "directory", size: 7, mtimeMs: 42 }
        : h === "fsRead"
          ? { content: Buffer.from("bin").toString("base64"), encoding: "base64", size: 3, truncated: false }
          : {},
    );
    const ws = client(ing.fetchImpl);
    expect(await ws.stat("d")).toEqual({ kind: "dir", size: 7, mtimeMs: 42 });
    expect(await ws.readFile("b")).toBe("bin");
  });

  it("a failed ensure is retried on the next op (cache not poisoned)", async () => {
    let fail = true;
    const ing = fakeIngress((h) => {
      if (h === "ensure" && fail) {
        fail = false;
        throw new Error("boom"); // thrown inside respond → rejects the fetch
      }
      return h === "fsRead" ? { content: "ok", encoding: "utf8", size: 2, truncated: false } : {};
    });
    const ws = client(ing.fetchImpl);
    await expect(ws.readFile("f")).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // let the cache-eviction .catch run
    expect(await ws.readFile("f")).toBe("ok");
    expect(ing.calls.filter((c) => c.handler === "ensure")).toHaveLength(2);
  });

  it("surfaces non-2xx as a thrown error naming the handler", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const ws = client(fetchImpl);
    await expect(ws.readFile("f")).rejects.toThrow(/workspace ensure .* 500/);
  });
});

describe("createIngressWorkspaceClient — abort→kill (0002:T3.1)", () => {
  it("abort mid-exec fires the workspace kill handler for THIS execId, at most once", async () => {
    const ing = fakeIngress((h) => (h === "exec" ? execResult({ outcome: "killed", exitCode: null }) : {}));
    const abort = new AbortController();
    const ws = client(ing.fetchImpl);

    ing.holdNext("exec");
    const pending = ws.exec("sleep 999", { signal: abort.signal });
    // Wait until the exec is actually dispatched (ensure resolved).
    while (!ing.calls.some((c) => c.handler === "exec")) await new Promise((r) => setTimeout(r, 0));

    abort.abort();
    abort.abort(); // double-abort ⇒ still once
    await new Promise((r) => setTimeout(r, 0));

    const kills = ing.calls.filter((c) => c.handler === "kill");
    expect(kills).toHaveLength(1);
    expect(kills[0]!.body["execId"]).toBe(deriveExecId("KEY#w0"));
    expect(kills[0]!.headers["idempotency-key"]).toBeUndefined(); // kill is idempotent by design

    // The host kill resolves the awakeable ⇒ exec RETURNS NORMALLY, killed outcome.
    ing.release("exec", execResult({ outcome: "killed", exitCode: null }));
    const res = await pending;
    expect(res.exitCode).toBe(-1);
    expect(res.tail).toContain("[exec killed]");
  });

  it("already-aborted signal skips dispatch entirely (immediate kill/no run)", async () => {
    const ing = fakeIngress();
    const abort = new AbortController();
    abort.abort();
    const ws = client(ing.fetchImpl);
    const res = await ws.exec("never", { signal: abort.signal });
    expect(res.tail).toContain("aborted before dispatch");
    expect(ing.calls.filter((c) => c.handler === "exec")).toHaveLength(0);
    // linkExecAbortToKill fires the (no-op) kill immediately.
    expect(ing.calls.filter((c) => c.handler === "kill")).toHaveLength(1);
  });

  it("abort AFTER natural completion is a no-op (listener disposed)", async () => {
    const ing = fakeIngress((h) => (h === "exec" ? execResult() : {}));
    const abort = new AbortController();
    const ws = client(ing.fetchImpl);
    const res = await ws.exec("echo done", { signal: abort.signal });
    expect(res.exitCode).toBe(0);
    abort.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(ing.calls.filter((c) => c.handler === "kill")).toHaveLength(0);
  });

  it("a rejected kill is swallowed and reported to onKillError (backstop still bounds the exec)", async () => {
    const errors: unknown[] = [];
    const ing = fakeIngress((h) => {
      if (h === "kill") throw new Error("kill transport down");
      return h === "exec" ? execResult({ outcome: "killed", exitCode: null }) : {};
    });
    const abort = new AbortController();
    const ws = client(ing.fetchImpl, { onKillError: (err: unknown) => errors.push(err) });

    ing.holdNext("exec");
    const pending = ws.exec("sleep 999", { signal: abort.signal });
    while (!ing.calls.some((c) => c.handler === "exec")) await new Promise((r) => setTimeout(r, 0));
    abort.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);

    ing.release("exec", execResult({ outcome: "timeout", exitCode: null, timeoutKind: "host-unresponsive" }));
    const res = await pending;
    expect(res.tail).toContain("timeout: host-unresponsive");
  });
});

describe("deriveExecId", () => {
  it("is deterministic and addressing-charset safe", () => {
    expect(deriveExecId("KEY#w0")).toBe(deriveExecId("KEY#w0"));
    expect(deriveExecId("KEY#w0")).not.toBe(deriveExecId("KEY#w1"));
    expect(deriveExecId("anything")).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  });
});
