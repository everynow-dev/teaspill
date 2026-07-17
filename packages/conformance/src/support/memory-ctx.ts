/**
 * An in-memory `AgentRuntimeCtx` (coordination/agent-runtime) for the OFFLINE
 * scenario runners — the same "structural fake context that persists K/V
 * across invocations" pattern the coordination unit tests use, extracted here
 * so the conformance runners are self-contained and reusable by T9.1.
 *
 * `MemoryWorld` owns one virtual-object key's durable K/V + a captured send
 * log; `world.ctx()` mints a fresh context per modeled invocation (all sharing
 * the same K/V, exactly like separate exclusive wakes on one key). A single
 * `crashAfterRun` latch models a crash between a `ctx.run` body committing and
 * its result being journaled — the D3 confirm-then-trim window.
 */

import type { AgentRuntimeCtx } from "@teaspill/coordination";

export interface CapturedSend {
  service: string;
  method: string;
  key?: string;
  parameter: unknown;
  delay?: number;
}

export class MemoryWorld {
  readonly state = new Map<string, unknown>();
  readonly sent: CapturedSend[] = [];
  constructor(readonly key: string) {}

  /**
   * Mint a context for one modeled invocation. `crashAfterRun: true` makes the
   * NEXT `ctx.run` throw AFTER its body has run (effects landed, result lost) —
   * the crash-between-append-and-trim window (projection-outbox crash matrix).
   */
  ctx(opts: { invocationId?: string; crashAfterRun?: boolean } = {}): AgentRuntimeCtx {
    const state = this.state;
    const sent = this.sent;
    let crashArmed = opts.crashAfterRun ?? false;
    return {
      key: this.key,
      invocationId: opts.invocationId ?? "inv",
      runAbortSignal: new AbortController().signal,
      get<T>(name: string): Promise<T | null> {
        return Promise.resolve(state.has(name) ? (state.get(name) as T) : null);
      },
      set<T>(name: string, value: T): void {
        state.set(name, value);
      },
      clear(name: string): void {
        state.delete(name);
      },
      async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
        const result = await action();
        if (crashArmed) {
          crashArmed = false;
          throw new Error("simulated crash after run (effects landed, result lost)");
        }
        return result;
      },
      genericSend(call: CapturedSend): void {
        sent.push(call);
      },
      raceInterrupt<T>(work: Promise<T>): Promise<T> {
        return work;
      },
    };
  }

  kv<T>(name: string): T | null {
    return this.state.has(name) ? (this.state.get(name) as T) : null;
  }
}
