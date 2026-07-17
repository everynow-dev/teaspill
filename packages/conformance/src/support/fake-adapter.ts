/**
 * A manually-driven `ExecutorAdapter` (executor/adapter) for the offline
 * workspace-exec durability scenario. Each `startExec` returns a handle whose
 * `wait()` resolves only when the test calls `completeExec(execId)` — so the
 * scenario can hold a "long" exec open across a simulated agent-loop restart,
 * then complete it and observe the awakeable resolve.
 *
 * It implements only what `ExecutorHost` touches (`ensure` → `startExec` /
 * `dispose`); the FS methods reject, since the scenario never calls them.
 */

import type {
  DirEntry,
  EnsureParams,
  ExecCompletion,
  ExecHandle,
  ExecStartOpts,
  ExecutorAdapter,
  FileStat,
  ReadResult,
  WorkspaceEnv,
} from "@teaspill/executor";

interface PendingExec {
  resolve: (completion: ExecCompletion) => void;
  killed: boolean;
}

export class ManualExecAdapter implements ExecutorAdapter {
  readonly name = "conformance-manual";
  readonly readContainment = "workspace" as const;
  /** Live exec handles by execId, so the test can complete/kill them. */
  readonly pending = new Map<string, PendingExec>();
  /** Count of distinct exec starts (dedup at the host means one per execId). */
  startCount = 0;

  ensure(params: EnsureParams): Promise<WorkspaceEnv> {
    return Promise.resolve(this.#env(params.workspaceKey));
  }

  /** Resolve a running exec's `wait()` with a successful completion. */
  completeExec(execId: string, completion?: Partial<ExecCompletion>): void {
    const p = this.pending.get(execId);
    if (!p) throw new Error(`completeExec: no pending exec ${execId}`);
    this.pending.delete(execId);
    p.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      killed: p.killed,
      tail: { stdout: "", stderr: "", truncated: false },
      durationMs: 1,
      ...completion,
    });
  }

  #env(workspaceKey: string): WorkspaceEnv {
    const reject = (op: string): Promise<never> =>
      Promise.reject(new Error(`ManualExecAdapter: ${op} not supported`));
    return {
      workspaceKey,
      workingDirectory: `/work/${workspaceKey}`,
      startExec: (opts: ExecStartOpts): ExecHandle => {
        this.startCount += 1;
        let resolveWait!: (c: ExecCompletion) => void;
        const done = new Promise<ExecCompletion>((r) => {
          resolveWait = r;
        });
        const record: PendingExec = { resolve: resolveWait, killed: false };
        this.pending.set(opts.execId, record);
        return {
          execId: opts.execId,
          wait: () => done,
          kill: () => {
            record.killed = true;
          },
        };
      },
      readFile: (): Promise<ReadResult> => reject("readFile"),
      writeFile: () => reject("writeFile"),
      mkdir: () => reject("mkdir"),
      rm: () => reject("rm"),
      stat: (): Promise<FileStat> => reject("stat"),
      ls: (): Promise<DirEntry[]> => reject("ls"),
      dispose: () => Promise.resolve(),
    };
  }
}
