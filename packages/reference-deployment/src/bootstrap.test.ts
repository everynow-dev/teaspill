/**
 * The load-bearing bootstrap order (0002:T4.1): listen → gateway-health wait
 * (CLI `waitForHealthy`) → register with backoff → post-registration
 * scheduling (the 0002:T2.2 `scheduleReconcilers` slot) — each step retried,
 * never reordered.
 */

import { describe, expect, it } from "vitest";
import { runBootstrapSequence } from "./bootstrap.js";

const instantBackoff = { baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} };

describe("runBootstrapSequence", () => {
  it("runs listen → health → register → schedule, in order", async () => {
    const order: string[] = [];
    const result = await runBootstrapSequence(
      {
        listen: async () => {
          order.push("listen");
          return 9080;
        },
        healthProbe: async () => {
          order.push("health");
          return true;
        },
        register: async () => {
          order.push("register");
        },
        schedule: async () => {
          order.push("schedule");
        },
      },
      { backoff: instantBackoff, logger: () => {} },
    );
    expect(order).toEqual(["listen", "health", "register", "schedule"]);
    expect(result.port).toBe(9080);
  });

  it("waits out an unhealthy gateway and retries a failing registration (the register-before-up race)", async () => {
    let health = 0;
    let register = 0;
    const order: string[] = [];
    await runBootstrapSequence(
      {
        listen: async () => 1,
        healthProbe: async () => {
          order.push(`health${health}`);
          return ++health >= 3; // refuse twice, then healthy
        },
        register: async () => {
          order.push(`register${register}`);
          if (++register < 2) throw new Error("gateway 503");
        },
      },
      { backoff: instantBackoff, logger: () => {} },
    );
    expect(order).toEqual(["health0", "health1", "health2", "register0", "register1"]);
  });

  it("a schedule failure retries AFTER registration (discovery lag), then succeeds", async () => {
    let schedule = 0;
    await runBootstrapSequence(
      {
        listen: async () => 1,
        healthProbe: async () => true,
        register: async () => {},
        schedule: async () => {
          if (++schedule < 3) throw new Error("service not found yet");
        },
      },
      { backoff: instantBackoff, logger: () => {} },
    );
    expect(schedule).toBe(3);
  });

  it("no schedule step ⇒ sequence completes without it (the executor shape)", async () => {
    const order: string[] = [];
    await runBootstrapSequence(
      {
        listen: async () => 2,
        healthProbe: async () => true,
        register: async () => {
          order.push("register");
        },
      },
      { backoff: instantBackoff, logger: () => {} },
    );
    expect(order).toEqual(["register"]);
  });

  it("registration never fires before the gateway is healthy, even when health never comes", async () => {
    let registered = false;
    await expect(
      runBootstrapSequence(
        {
          listen: async () => 1,
          healthProbe: async () => false,
          register: async () => {
            registered = true;
          },
        },
        { backoff: { ...instantBackoff, maxAttempts: 3 }, logger: () => {} },
      ),
    ).rejects.toThrow(/healthy/);
    expect(registered).toBe(false);
  });
});
