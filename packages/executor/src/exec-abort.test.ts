import { describe, expect, it, vi } from "vitest";
import { linkExecAbortToKill } from "./exec-abort.js";

const EXEC_ID = "exec-abc123";

describe("linkExecAbortToKill (0002:T3.1)", () => {
  it("no signal ⇒ never fires kill, dispose is a safe no-op, not alreadyAborted", () => {
    const kill = vi.fn();
    const link = linkExecAbortToKill({ execId: EXEC_ID, kill });
    expect(link.alreadyAborted).toBe(false);
    link.dispose();
    link.dispose(); // idempotent
    expect(kill).not.toHaveBeenCalled();
  });

  it("already-aborted before exec ⇒ fires kill immediately and reports alreadyAborted (immediate kill / no run)", () => {
    const kill = vi.fn();
    const ac = new AbortController();
    ac.abort();
    const link = linkExecAbortToKill({ signal: ac.signal, execId: EXEC_ID, kill });
    expect(link.alreadyAborted).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(EXEC_ID);
  });

  it("abort mid-exec ⇒ fires kill once with the right execId", () => {
    const kill = vi.fn();
    const ac = new AbortController();
    const link = linkExecAbortToKill({ signal: ac.signal, execId: EXEC_ID, kill });
    expect(link.alreadyAborted).toBe(false);
    expect(kill).not.toHaveBeenCalled();

    ac.abort();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(EXEC_ID);

    // A second abort dispatch cannot re-fire (guarded).
    ac.signal.dispatchEvent(new Event("abort"));
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("abort AFTER natural completion (dispose called) ⇒ no-op", () => {
    const kill = vi.fn();
    const ac = new AbortController();
    const link = linkExecAbortToKill({ signal: ac.signal, execId: EXEC_ID, kill });
    // Exec completed naturally → caller disposes the link.
    link.dispose();
    ac.abort();
    expect(kill).not.toHaveBeenCalled();
  });

  it("double-abort fires kill at most once", () => {
    const kill = vi.fn();
    const ac = new AbortController();
    const link = linkExecAbortToKill({ signal: ac.signal, execId: EXEC_ID, kill });
    ac.abort();
    ac.signal.dispatchEvent(new Event("abort"));
    ac.signal.dispatchEvent(new Event("abort"));
    link.dispose();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("swallows a synchronous kill throw and routes it to onKillError (best-effort)", () => {
    const err = new Error("ingress down");
    const onKillError = vi.fn();
    const kill = vi.fn(() => {
      throw err;
    });
    const ac = new AbortController();
    linkExecAbortToKill({ signal: ac.signal, execId: EXEC_ID, kill, onKillError });
    // Must not throw out of the abort handler.
    expect(() => ac.abort()).not.toThrow();
    expect(onKillError).toHaveBeenCalledWith(err);
  });

  it("swallows a rejected async kill and routes it to onKillError", async () => {
    const err = new Error("kill rejected");
    const onKillError = vi.fn();
    const kill = vi.fn(() => Promise.reject(err));
    const ac = new AbortController();
    linkExecAbortToKill({ signal: ac.signal, execId: EXEC_ID, kill, onKillError });
    ac.abort();
    // Let the rejection microtask settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(onKillError).toHaveBeenCalledWith(err);
  });

  it("an onKillError that itself throws cannot break the abort flow", () => {
    const kill = vi.fn(() => {
      throw new Error("boom");
    });
    const onKillError = vi.fn(() => {
      throw new Error("observer boom");
    });
    const ac = new AbortController();
    linkExecAbortToKill({ signal: ac.signal, execId: EXEC_ID, kill, onKillError });
    expect(() => ac.abort()).not.toThrow();
  });
});
