/**
 * Concrete ingress `WorkspaceClient` (0002:T4.1 — the 0001:T6.2 deployment
 * seam, finally real). Routes every `WorkspaceClient` method through Restate
 * ingress to the `workspace/<key>` virtual object (`@teaspill/executor`),
 * and wires 0002:T3.1's abort→kill contract via `linkExecAbortToKill`.
 *
 * ## Exactly-once (0001:T3.1 invariant 1)
 *
 * The client is BOUND to one tool invocation's idempotency key
 * (`(entityUrl, runId, toolUseId)` rendered). Side-effecting calls (`exec`,
 * `writeFile`, `mkdir`, `rm`) each carry a DERIVED key
 * `<boundKey>#w<n>` where `n` is the client-local operation counter: a fresh
 * client is constructed per tool call, and a retried tool step re-executes the
 * same operation sequence, so the derived keys are replay-stable AND two
 * different side effects inside one tool call (e.g. `edit_file`'s read→write)
 * can never collapse into each other at the ingress dedup. Read-only calls
 * carry no key.
 *
 * ## exec + abort (0002:T3.1)
 *
 * - `execId` is derived deterministically from the operation key (sha-256,
 *   addressing id charset), so a retried step re-dispatches the SAME exec —
 *   the workspace object + host dedup on it — and the abort path knows which
 *   exec to kill without any shared state.
 * - `opts.signal` is linked via `linkExecAbortToKill`: on abort the client
 *   fires the workspace `kill` handler for this `execId` (a shared handler —
 *   it never queues behind the blocked exclusive `exec`), driving the
 *   0001:T4.1 3-layer kill; the exec then RETURNS NORMALLY with a killed
 *   outcome. Already-aborted ⇒ the exec is never dispatched.
 *
 * ## ensure-on-first-use
 *
 * The workspace object requires `ensure(config)` before any op. The client
 * ensures LAZILY, memoized per `(ingressUrl, workspaceRef)` in a process-wide
 * cache (injectable) — `ensure` is an idempotent reattach (0001:D4), so
 * concurrent/replayed ensures are harmless and a failed ensure is retried on
 * the next op.
 */

import { createHash } from "node:crypto";
import { linkExecAbortToKill } from "@teaspill/executor";
import type {
  DirEntry,
  FileStat,
  ReadResult,
  WorkspaceEnsureConfig,
  WorkspaceEnsureResult,
  WorkspaceExecResult,
} from "@teaspill/executor";
import type { ExecOptions, ExecResult, WorkspaceClient } from "@teaspill/harness-native";

export interface IngressWorkspaceClientOptions {
  /** Restate ingress base url as seen from THIS process (e.g. `http://restate:8080`). */
  ingressUrl: string;
  /** Workspace key `<tenant>/<name>` this client is bound to (0001:D4). */
  workspaceRef: string;
  /** Ensure config for lazy first-use ensure. Default `{ adapter: "docker" }`. */
  ensure?: WorkspaceEnsureConfig;
  /** The bound tool-invocation idempotency key (0001:T3.1 invariant 1). */
  idempotencyKey: string;
  fetch?: typeof fetch;
  /** Extra headers on every ingress call. */
  headers?: Record<string, string>;
  /** Observe abort→kill failures (best-effort; the awakeable backstop still bounds the exec). */
  onKillError?: (err: unknown) => void;
  /** Injectable ensure memo (tests). Default: a module-level process-wide cache. */
  ensureCache?: Map<string, Promise<void>>;
}

const processEnsureCache = new Map<string, Promise<void>>();

/** Derive a replay-stable exec id (addressing id charset, ≤64) from an operation key. */
export function deriveExecId(operationKey: string): string {
  return `k${createHash("sha256").update(operationKey).digest("hex").slice(0, 40)}`;
}

export function createIngressWorkspaceClient(opts: IngressWorkspaceClientOptions): WorkspaceClient {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = opts.ingressUrl.replace(/\/$/, "");
  const ref = opts.workspaceRef;
  const ensureConfig: WorkspaceEnsureConfig = opts.ensure ?? { adapter: "docker" };
  const ensureCache = opts.ensureCache ?? processEnsureCache;
  // Client-local op counter — replay-stable (a fresh client per tool call; a
  // retried step reconstructs the client and re-runs the same op sequence).
  let op = 0;
  const nextOpKey = (): string => `${opts.idempotencyKey}#w${op++}`;

  async function call<T>(
    handler: string,
    body: unknown,
    callOpts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const res = await doFetch(`${base}/workspace/${encodeURIComponent(ref)}/${handler}`, {
      method: "POST",
      headers: {
        ...opts.headers,
        "content-type": "application/json",
        ...(callOpts.idempotencyKey !== undefined && {
          "idempotency-key": callOpts.idempotencyKey,
        }),
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`workspace ${handler} for ${JSON.stringify(ref)} failed: ${res.status} ${text}`);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  function ensureOnce(): Promise<void> {
    const cacheKey = `${base}|${ref}`;
    let pending = ensureCache.get(cacheKey);
    if (!pending) {
      pending = call<WorkspaceEnsureResult>("ensure", { config: ensureConfig }).then(() => {});
      // A failed ensure must not poison the cache — the next op retries.
      pending.catch(() => ensureCache.delete(cacheKey));
      ensureCache.set(cacheKey, pending);
    }
    return pending;
  }

  const toExecResult = (res: WorkspaceExecResult): ExecResult => {
    const parts: string[] = [];
    if (res.tailBytes.stdout) parts.push(res.tailBytes.stdout);
    if (res.tailBytes.stderr) parts.push(`[stderr]\n${res.tailBytes.stderr}`);
    if (res.outcome === "killed") parts.push("[exec killed]");
    if (res.outcome === "timeout") parts.push(`[exec timeout: ${res.timeoutKind ?? "exec"}]`);
    return {
      exitCode: res.exitCode ?? -1,
      tail: parts.join("\n"),
      streamRef: res.streamRef,
    };
  };

  return {
    workspaceRef: ref,

    async exec(cmd: string, execOpts?: ExecOptions): Promise<ExecResult> {
      const operationKey = nextOpKey();
      const execId = deriveExecId(operationKey);
      // 0002:T3.1: abort → workspace `kill` (shared handler, no idempotency
      // key needed — kill-of-completed/unknown is a host-side no-op).
      const link = linkExecAbortToKill({
        signal: execOpts?.signal,
        execId,
        kill: (id) => call("kill", { execId: id }).then(() => {}),
        ...(opts.onKillError !== undefined && { onKillError: opts.onKillError }),
      });
      if (link.alreadyAborted) {
        // Skip dispatch entirely — treat as killed before start (0002:T3.1).
        return { exitCode: -1, tail: "[exec aborted before dispatch]" };
      }
      try {
        await ensureOnce();
        const res = await call<WorkspaceExecResult>(
          "exec",
          {
            command: cmd,
            execId,
            ...(execOpts?.cwd !== undefined && { cwd: execOpts.cwd }),
            ...(execOpts?.env !== undefined && { env: execOpts.env }),
            ...(execOpts?.timeoutMs !== undefined && { timeoutMs: execOpts.timeoutMs }),
          },
          { idempotencyKey: operationKey },
        );
        return toExecResult(res);
      } finally {
        link.dispose();
      }
    },

    async readFile(path: string): Promise<string> {
      await ensureOnce();
      const res = await call<ReadResult>("fsRead", { path });
      return res.encoding === "base64" ? Buffer.from(res.content, "base64").toString("utf8") : res.content;
    },

    async writeFile(path: string, content: string): Promise<void> {
      await ensureOnce();
      await call("fsWrite", { path, content }, { idempotencyKey: nextOpKey() });
    },

    async ls(path: string): Promise<string[]> {
      await ensureOnce();
      const res = await call<DirEntry[]>("fsLs", { path });
      return res.map((e) => e.name);
    },

    async mkdir(path: string): Promise<void> {
      await ensureOnce();
      await call("fsMkdir", { path, recursive: true }, { idempotencyKey: nextOpKey() });
    },

    async rm(path: string): Promise<void> {
      await ensureOnce();
      await call("fsRm", { path, recursive: true }, { idempotencyKey: nextOpKey() });
    },

    async stat(path: string): Promise<{ kind: "file" | "dir"; size: number; mtimeMs: number }> {
      await ensureOnce();
      const res = await call<FileStat>("fsStat", { path });
      return { kind: res.type === "directory" ? "dir" : "file", size: res.size, mtimeMs: res.mtimeMs };
    },
  };
}
