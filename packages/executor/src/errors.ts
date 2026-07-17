/**
 * Executor error vocabulary (T4.1), ported from electric's sandbox layer
 * (`../electric/packages/agents-runtime/src/sandbox/types.ts` —
 * `SandboxError`/`SandboxErrorKind`): three kinds, so callers can branch on
 * *why* without string-matching messages.
 *
 * - `policy` — the request violated a containment/policy boundary (e.g. a
 *   path escaping the workspace). Never retryable.
 * - `runtime` — the operation itself failed (missing file, spawn failure…).
 * - `unavailable` — the environment does not exist / cannot be attached
 *   (e.g. attach-only semantics, disposed workspace).
 */

export type WorkspaceErrorKind = "policy" | "runtime" | "unavailable";

export class WorkspaceError extends Error {
  readonly kind: WorkspaceErrorKind;
  constructor(kind: WorkspaceErrorKind, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.kind = kind;
  }
}

/** Serializable projection of a WorkspaceError for host→object result payloads. */
export interface WorkspaceErrorShape {
  kind: WorkspaceErrorKind;
  message: string;
}

export function toWorkspaceErrorShape(err: unknown): WorkspaceErrorShape {
  if (err instanceof WorkspaceError) return { kind: err.kind, message: err.message };
  return { kind: "runtime", message: err instanceof Error ? err.message : String(err) };
}
