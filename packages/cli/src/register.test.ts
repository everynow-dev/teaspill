import { describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  GatewayUnhealthyError,
  retryWithBackoff,
  waitForHealthy,
} from "./register.js";

const instantSleep = (): Promise<void> => Promise.resolve();

describe("backoffDelay", () => {
  it("grows exponentially and caps at maxDelayMs", () => {
    expect(backoffDelay(1, 250, 5000)).toBe(250);
    expect(backoffDelay(2, 250, 5000)).toBe(500);
    expect(backoffDelay(3, 250, 5000)).toBe(1000);
    expect(backoffDelay(10, 250, 5000)).toBe(5000); // capped
  });
});

describe("waitForHealthy — the register-before-gateway-up race (0001:T6.2 anticipated bug)", () => {
  it("retries a probe that fails N times, then resolves when it succeeds", async () => {
    let calls = 0;
    const N = 3;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls > N; // false for the first N calls, then true
    });
    const onRetry = vi.fn();

    await waitForHealthy(probe, { sleep: instantSleep, onRetry });

    expect(probe).toHaveBeenCalledTimes(N + 1); // N failures + 1 success
    expect(onRetry).toHaveBeenCalledTimes(N); // one backoff per failure
  });

  it("treats a THROWING probe (connection refused before the port opens) as not-ready", async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return true;
    });
    await waitForHealthy(probe, { sleep: instantSleep });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("throws GatewayUnhealthyError after maxAttempts failures", async () => {
    const probe = vi.fn(async () => false);
    await expect(
      waitForHealthy(probe, { sleep: instantSleep, maxAttempts: 4 }),
    ).rejects.toBeInstanceOf(GatewayUnhealthyError);
    expect(probe).toHaveBeenCalledTimes(4);
  });
});

describe("retryWithBackoff — deployment registration", () => {
  it("retries a register op that fails N times, then returns its value", async () => {
    let calls = 0;
    const op = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("gateway 503");
      return { ok: true, calls };
    });
    const onRetry = vi.fn();

    const result = await retryWithBackoff(op, { sleep: instantSleep, onRetry });

    expect(result).toEqual({ ok: true, calls: 3 });
    expect(op).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last error after maxAttempts", async () => {
    const op = vi.fn(async () => {
      throw new Error("still down");
    });
    await expect(retryWithBackoff(op, { sleep: instantSleep, maxAttempts: 3 })).rejects.toThrow(
      "still down",
    );
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("does not retry when isRetryable returns false", async () => {
    const op = vi.fn(async () => {
      throw new Error("401 unauthorized");
    });
    await expect(
      retryWithBackoff(op, { sleep: instantSleep, isRetryable: () => false }),
    ).rejects.toThrow("401");
    expect(op).toHaveBeenCalledTimes(1);
  });
});
