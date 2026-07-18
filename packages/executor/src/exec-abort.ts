/**
 * Exec abort → kill mapping (0002:T3.1) — the client-side glue that turns an
 * `AbortSignal` on `WorkspaceClient.exec` (see `ExecOptions.signal` in
 * `@teaspill/harness-native`) into a call on the workspace `kill` path.
 *
 * ## Why this exists (the ingress boundary)
 *
 * A `WorkspaceClient` routes `exec` through Restate ingress to the
 * `workspace/<key>` object; the process runs on the executor host in another
 * invocation. An in-process `AbortSignal` cannot reach that process — there is
 * no shared event loop to observe `.aborted`. The ONLY way to stop it is the
 * existing 3-layer kill (0001:T4.1, ./workspace.ts): fire the workspace `kill`
 * handler for the exec's `execId` → host kills the process tree → the exec's
 * awakeable resolves with `killed: true` → `exec` returns a killed outcome.
 *
 * This helper encapsulates that mapping so every concrete `WorkspaceClient`
 * (the deployment-side ingress client built in 0002:T4.1) wires abort→kill the
 * same way, idempotently. It is transport-agnostic: the caller passes a `kill`
 * callback that performs the actual ingress `kill({ execId })` call.
 *
 * ## Idempotency (inherits the 0001:T4.1 kill safety)
 *
 * - `kill` fires AT MOST ONCE, only on abort.
 * - Already-aborted signal at link time ⇒ fires `kill` immediately and reports
 *   `alreadyAborted` so the caller can skip dispatch ("immediate kill / no
 *   run"). Killing a never-dispatched / unknown exec is a host-side no-op.
 * - `dispose()` (call it in a `finally` after the exec completes naturally)
 *   detaches the listener, so a later abort is a no-op. `dispose()` is itself
 *   idempotent.
 * - Double-abort fires `kill` once (guarded, independent of the DOM
 *   guarantee that `abort` dispatches once).
 * - No signal ⇒ `kill` never fires; `dispose()` is a no-op.
 *
 * `kill` is best-effort: it may be async, and any rejection/throw is routed to
 * `onKillError` and swallowed — the workspace object's awakeable timeout
 * backstop (0001:T4.1 defense 2) still bounds a wedged exec if the kill never
 * lands.
 */

export interface LinkExecAbortOptions {
  /** The exec's abort signal (typically `ToolContext.signal`). Omit for no linkage. */
  signal?: AbortSignal | undefined;
  /** Stable execId the client dispatches this exec under — the kill target. */
  execId: string;
  /**
   * Fire the workspace `kill` handler for `execId` (an ingress call). Invoked
   * at most once, only on abort. Must be idempotent-safe upstream
   * (kill-of-completed/unknown is a host-side no-op).
   */
  kill: (execId: string) => void | Promise<void>;
  /** Observe a failed/ rejected `kill` (best-effort; default: swallow silently). */
  onKillError?: (err: unknown) => void;
}

export interface ExecAbortLink {
  /**
   * True iff the signal was ALREADY aborted when the link was created. The
   * caller should skip dispatch entirely (nothing to run) — `kill` has already
   * been fired as a harmless no-op — and treat the exec as killed.
   */
  readonly alreadyAborted: boolean;
  /**
   * Detach the abort listener. Call in a `finally` once the exec has resolved
   * so a later abort of the (now-completed) run does not fire a stray kill.
   * Idempotent and safe to call even when no signal was provided.
   */
  dispose(): void;
}

/**
 * Link an exec's `AbortSignal` to the workspace kill path. See the module
 * header for the full contract.
 */
export function linkExecAbortToKill(opts: LinkExecAbortOptions): ExecAbortLink {
  const { signal, execId, kill, onKillError } = opts;

  let fired = false;
  const fireKillOnce = (): void => {
    if (fired) return;
    fired = true;
    try {
      const out = kill(execId);
      if (out && typeof (out as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(out).then(undefined, (err) => reportKillError(err));
      }
    } catch (err) {
      reportKillError(err);
    }
  };
  const reportKillError = (err: unknown): void => {
    try {
      onKillError?.(err);
    } catch {
      // An onKillError that throws must not break the caller's exec flow.
    }
  };

  // No signal: byte-identical to pre-0002 — nothing to observe, nothing to detach.
  if (!signal) {
    return { alreadyAborted: false, dispose: () => {} };
  }

  // Already aborted: fire the (no-op) kill now and tell the caller to skip dispatch.
  if (signal.aborted) {
    fireKillOnce();
    return { alreadyAborted: true, dispose: () => {} };
  }

  const onAbort = (): void => {
    fireKillOnce();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  let disposed = false;
  return {
    alreadyAborted: false,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", onAbort);
    },
  };
}
