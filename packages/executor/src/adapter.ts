/**
 * Executor adapter interface (0001:T4.1 → implemented by 0001:T4.2) — the seam behind
 * which real environments live. The shape is a deliberate trim of electric's
 * `Sandbox` interface (`../electric/packages/agents-runtime/src/sandbox/types.ts`)
 * to exactly what the workspace object + executor host need:
 *
 *     ExecutorAdapter.ensure(params) → WorkspaceEnv
 *     WorkspaceEnv.{startExec, readFile, writeFile, mkdir, rm, stat, ls, dispose}
 *
 * 0001:D4: `workspace/<key>` objects front real environments; **Docker first,
 * local-unrestricted for dev, remote later** — 0001:T4.2 slots `docker` (container
 * per workspace, volume-backed, idle teardown) and hardens
 * `local-unrestricted` behind this exact interface. This package ships only
 * the dev-only `local` adapter (./local-adapter.ts) to prove the
 * object↔host↔adapter flow end to end.
 *
 * Design constraints inherited from electric's factory contract:
 * - **Identity from the key alone.** `ensure` must be able to create OR
 *   REATTACH from `workspaceKey` + config with no in-process memory — a
 *   restarted host must reach the same environment (docker: deterministic
 *   container/volume name; local: deterministic directory).
 * - **Callers never pre-resolve paths.** FS methods own path resolution and
 *   containment (see ./path-containment.ts) against the filesystem the
 *   adapter actually owns; callers pass user paths straight through.
 * - **Writes contained everywhere; read containment documented per adapter**
 *   via `readContainment`.
 */

import type { JsonValue } from "@teaspill/schema";

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Stable list of bundled adapter names. `local` ships here (dev-only);
 * `docker` and the hardened `local-unrestricted` are 0001:T4.2; `remote` later.
 * Mirrors electric's `KNOWN_ADAPTERS` conformance-list pattern: 0001:T4.2's
 * cross-adapter conformance suite should assert it covers this list.
 */
export const KNOWN_ADAPTERS = ["local", "local-unrestricted", "docker", "remote"] as const;
export type KnownAdapterName = (typeof KNOWN_ADAPTERS)[number];

export interface ExecutorAdapter {
  /** Adapter identifier for config/logs (`local`, `docker`, …). Not a capability discriminator. */
  readonly name: KnownAdapterName | (string & {});
  /**
   * Read-containment stance (writes are contained on every adapter):
   * `workspace` = reads outside the workspace root reject with policy;
   * `environment` = reads anywhere inside the isolated environment are
   * allowed (the environment boundary is the containment).
   */
  readonly readContainment: "workspace" | "environment";
  /**
   * Create the environment for `workspaceKey` if absent, else reattach.
   * Idempotent; identity must derive from the key + config alone (no
   * in-process state), so a restarted host transparently reattaches.
   */
  ensure(params: EnsureParams): Promise<WorkspaceEnv>;
}

export interface EnsureParams {
  /** Workspace key `<tenant>/<name>` (0001:A3). */
  workspaceKey: string;
  config: WorkspaceEnsureConfig;
}

/**
 * The environment config carried in the workspace object's K/V and passed on
 * every host call (so a cold-started host can lazily re-`ensure`). Chosen at
 * spawn/ensure time and never switched (0001:D4).
 */
export interface WorkspaceEnsureConfig {
  /** Which adapter fronts this workspace (`local`, later `docker`, …). */
  adapter: string;
  /** Base env vars merged under each exec's own env. */
  env?: Record<string, string>;
  /** Adapter-specific options (docker image, volume, network policy — 0001:T4.2). */
  adapterOptions?: JsonValue;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface WorkspaceEnv {
  readonly workspaceKey: string;
  /** Absolute path of the environment's writable root (container path for isolated adapters). */
  readonly workingDirectory: string;

  /**
   * Start a command WITHOUT awaiting it (long-exec support, 0001:D4): returns a
   * handle immediately; completion arrives via `handle.wait()`. Output is
   * delivered incrementally through `opts.onChunk` (the host forwards it
   * out-of-band to the durable stream) and as bounded `tailBytes` on the
   * completion (the only output that rides the Restate journal, 0001:R4).
   */
  startExec(opts: ExecStartOpts): ExecHandle;

  // FS surface (the workspace object's `fs*` handlers map 1:1 onto these).
  // All paths resolve against `workingDirectory`; containment per module docs
  // in ./path-containment.ts. Errors are `WorkspaceError`s.
  readFile(path: string, opts?: { maxBytes?: number }): Promise<ReadResult>;
  writeFile(path: string, content: string, opts?: { encoding?: "utf8" | "base64" }): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<FileStat>;
  ls(path: string): Promise<DirEntry[]>;

  /**
   * Tear the environment down. `wipe: true` destroys persisted state (the
   * directory / volume); default preserves it so a later `ensure` reattaches.
   * Kills any still-running execs first.
   */
  dispose(opts?: { wipe?: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Exec
// ---------------------------------------------------------------------------

export interface ExecStartOpts {
  /** Dedup identity for this exec (host-level idempotence; replay-stable upstream). */
  execId: string;
  /** Shell command line (adapters run it via `sh -c` or equivalent). */
  command: string;
  /** Working directory, relative to the workspace root (contained). Defaults to the root. */
  cwd?: string;
  /** Env merged over the environment's base env. */
  env?: Record<string, string>;
  stdin?: string;
  /**
   * Hard wall-clock timeout enforced BY THE ADAPTER (kill-tree escalation).
   * The workspace object additionally enforces an awakeable-level timeout
   * (this value + grace) as the backstop for a dead host (anticipate-a).
   */
  timeoutMs: number;
  /** Max bytes retained per channel in the completion's `tailBytes` (0001:R4 journal budget). */
  maxTailBytes: number;
  /**
   * Incremental output callback. MUST be treated as fire-and-forget by
   * adapters: a throwing/slow consumer must never affect the exec. Chunks
   * are utf8 lossy-decoded per channel.
   */
  onChunk?: (chunk: ExecOutputChunk) => void;
  /** External abort (host dispose path). Same escalation as `timeoutMs`. */
  signal?: AbortSignal;
}

export interface ExecOutputChunk {
  channel: "stdout" | "stderr";
  /** utf8 text (lossy at chunk boundaries is acceptable — telemetry, not truth). */
  text: string;
}

export interface ExecHandle {
  readonly execId: string;
  /** Resolves exactly once, with the completion — never rejects for a command-level failure. */
  wait(): Promise<ExecCompletion>;
  /** Kill the command's whole process tree (SIGTERM → SIGKILL escalation). Idempotent. */
  kill(): void;
}

export interface ExecCompletion {
  /** Process exit code; null when terminated by signal / spawn failure. */
  exitCode: number | null;
  /** Terminating signal name, when signalled. */
  signal: string | null;
  /** True iff the ADAPTER's `timeoutMs` fired. */
  timedOut: boolean;
  /** True iff `kill()` (or the abort signal) terminated it. */
  killed: boolean;
  /** Last `maxTailBytes` bytes per channel (journal-bounded, 0001:R4). */
  tail: { stdout: string; stderr: string; truncated: boolean };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// FS result shapes
// ---------------------------------------------------------------------------

export interface ReadResult {
  /** File content, `encoding`-encoded, truncated to the read budget. */
  content: string;
  encoding: "utf8" | "base64";
  /** Actual file size in bytes (may exceed the returned content when truncated). */
  size: number;
  truncated: boolean;
}

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
}

export interface FileStat {
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}
