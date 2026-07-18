import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRON_SERVICE_NAME,
  type CronRuntimeCtx,
  type CronSpec,
  assertValidCronSpec,
  handleSchedule,
  handleTick,
  handleUnschedule,
  nextFireAfter,
} from "./cron.js";

// ---------------------------------------------------------------------------
// nextFireAfter — PURE, no Restate runtime involved.
// ---------------------------------------------------------------------------

describe("nextFireAfter (pure)", () => {
  it("computes the next occurrence of a simple expression, strictly after the given instant", () => {
    const after = Date.parse("2026-07-16T10:07:00Z");
    const next = nextFireAfter(after, "*/15 * * * *", "UTC");
    expect(new Date(next).toISOString()).toBe("2026-07-16T10:15:00.000Z");
  });

  it("is strictly-after: an instant exactly on the grid fires the FOLLOWING occurrence, not itself", () => {
    const onGrid = Date.parse("2026-07-16T10:15:00.000Z");
    const next = nextFireAfter(onGrid, "*/15 * * * *", "UTC");
    expect(new Date(next).toISOString()).toBe("2026-07-16T10:30:00.000Z");
  });

  it("throws a TerminalError for an unparseable expression", () => {
    expect(() => nextFireAfter(Date.now(), "not a cron", "UTC")).toThrow(/invalid|unparseable|cron/i);
  });

  // -------------------------------------------------------------------------
  // DST transition #1: spring-forward (America/New_York, 2026-03-08, 02:00
  // local clocks jump to 03:00 — the 02:00-02:59 wall-clock hour does not
  // exist that day).
  // -------------------------------------------------------------------------
  describe("DST spring-forward (America/New_York, 2026-03-08)", () => {
    it("a daily 09:00-local job has a 23-hour UTC gap across the transition (tz-aware, not a naive 24h step)", () => {
      const before = nextFireAfter(Date.parse("2026-03-07T00:00:00Z"), "0 9 * * *", "America/New_York");
      expect(new Date(before).toISOString()).toBe("2026-03-07T14:00:00.000Z"); // 09:00 EST = UTC-5

      const after = nextFireAfter(before, "0 9 * * *", "America/New_York");
      expect(new Date(after).toISOString()).toBe("2026-03-08T13:00:00.000Z"); // 09:00 EDT = UTC-4

      // Naive UTC-fixed-offset math would predict exactly 24h; a correct
      // tz-aware computation loses the spring-forward hour.
      expect(after - before).toBe(23 * 3_600_000);
    });

    it("a job scheduled inside the nonexistent 02:00-03:00 local window rolls forward past the gap instead of throwing or producing an invalid instant", () => {
      // 02:30 local never happens on 2026-03-08 in America/New_York.
      const next = nextFireAfter(Date.parse("2026-03-07T12:00:00Z"), "30 2 * * *", "America/New_York");
      const nyWallHour = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).format(new Date(next));
      // Whatever croner's exact resolution strategy, the result must be a
      // *representable* local instant — not 02:xx (which cannot exist).
      expect(nyWallHour).not.toBe("02");

      // And the day after settles back onto the normal 02:30 grid slot.
      const dayAfter = nextFireAfter(next, "30 2 * * *", "America/New_York");
      expect(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(dayAfter)),
      ).toBe("02:30");
    });
  });

  // -------------------------------------------------------------------------
  // DST transition #2: fall-back (America/New_York, 2026-11-01, 02:00 local
  // clocks fall back to 01:00 — the 01:00-01:59 wall-clock hour occurs
  // TWICE that day).
  // -------------------------------------------------------------------------
  describe("DST fall-back (America/New_York, 2026-11-01)", () => {
    it("a daily 09:00-local job has a 25-hour UTC gap across the transition", () => {
      const before = nextFireAfter(Date.parse("2026-10-31T00:00:00Z"), "0 9 * * *", "America/New_York");
      expect(new Date(before).toISOString()).toBe("2026-10-31T13:00:00.000Z"); // 09:00 EDT = UTC-4

      const after = nextFireAfter(before, "0 9 * * *", "America/New_York");
      expect(new Date(after).toISOString()).toBe("2026-11-01T14:00:00.000Z"); // 09:00 EST = UTC-5

      expect(after - before).toBe(25 * 3_600_000);
    });

    it("a job scheduled in the doubled 01:00-02:00 local window fires exactly once that day, not twice", () => {
      // 01:30 local occurs at 05:30Z (EDT, first pass) AND at 06:30Z (EST,
      // second pass) on 2026-11-01. A correct implementation must pick one
      // and not re-fire "the same" 01:30 a second time later that day.
      const first = nextFireAfter(Date.parse("2026-10-31T12:00:00Z"), "30 1 * * *", "America/New_York");
      const second = nextFireAfter(first, "30 1 * * *", "America/New_York");

      // The next occurrence after the first must be the FOLLOWING day's
      // 01:30, not the other copy of the same local wall-clock instant
      // later on 2026-11-01 (i.e. the gap is a full ~24-25h day, not ~1h).
      expect(second - first).toBeGreaterThan(20 * 3_600_000);
      expect(
        new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit" }).format(
          new Date(second),
        ),
      ).toBe("11/02");
    });
  });
});

describe("assertValidCronSpec (pure)", () => {
  const base: CronSpec = {
    expression: "0 9 * * *",
    timezone: "America/New_York",
    target: { service: "agent.researcher", key: "abc", handler: "wake" },
    payload: { hello: "world" },
  };

  it("accepts a well-formed spec", () => {
    expect(() => assertValidCronSpec(base)).not.toThrow();
  });

  it("rejects an unparseable cron expression", () => {
    expect(() => assertValidCronSpec({ ...base, expression: "not a cron" })).toThrow();
  });

  it("rejects an invalid IANA timezone name (resolved lazily by croner — must be forced eagerly here)", () => {
    expect(() => assertValidCronSpec({ ...base, timezone: "Not/AZone" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Handler logic — exercised against an in-memory fake CronRuntimeCtx.
//
// NOT a substitute for a live-Restate conformance test (0001:T6.3): this does not
// cover real delayed-send delivery timing, exactly-once dedup, or replay of
// a crashed ctx.run. It DOES exercise the control-flow logic exactly as
// written (same handleSchedule/handleUnschedule/handleTick functions the
// real restate.object(...) wiring calls), including the generation-guard
// scenario this task calls out as the classic self-rescheduling footgun.
// ---------------------------------------------------------------------------

class FakeCronCtx implements CronRuntimeCtx {
  readonly key: string;
  private readonly state = new Map<string, unknown>();
  readonly sent: Array<{
    service: string;
    method: string;
    key?: string;
    parameter: unknown;
    delay?: number;
  }> = [];

  constructor(key: string) {
    this.key = key;
  }

  async get<T>(name: string): Promise<T | null> {
    return this.state.has(name) ? (this.state.get(name) as T) : null;
  }

  set<T>(name: string, value: T): void {
    this.state.set(name, value);
  }

  clear(name: string): void {
    this.state.delete(name);
  }

  async run<T>(_name: string, action: () => T | Promise<T>): Promise<T> {
    return action();
  }

  genericSend(call: { service: string; method: string; key?: string; parameter: unknown; delay?: number }): void {
    this.sent.push(call);
  }

  /** Test helper: the self-reschedule sends this fake has captured so far. */
  selfSends(): Array<{ generation: number; scheduledFor: number }> {
    return this.sent
      .filter((c) => c.service === CRON_SERVICE_NAME && c.method === "tick")
      .map((c) => c.parameter as { generation: number; scheduledFor: number });
  }

  /** Test helper: the target-payload sends this fake has captured so far. */
  targetSends(): Array<{ service: string; key?: string; method: string; parameter: unknown }> {
    return this.sent.filter((c) => !(c.service === CRON_SERVICE_NAME && c.method === "tick"));
  }
}

const spec: CronSpec = {
  expression: "*/5 * * * *",
  timezone: "UTC",
  target: { service: "agent.researcher", key: "instance-1", handler: "wake" },
  payload: { kind: "nightly-report" },
};

describe("handleSchedule / handleTick / handleUnschedule (fake-context)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedule() sets generation 1, computes the first fire time, and self-sends exactly one tick", async () => {
    const ctx = new FakeCronCtx("nightly-report");
    const result = await handleSchedule(ctx, spec);

    expect(result.generation).toBe(1);
    expect(new Date(result.nextFireAt).toISOString()).toBe("2026-07-16T10:05:00.000Z");
    expect(ctx.selfSends()).toEqual([{ generation: 1, scheduledFor: result.nextFireAt }]);
    expect(ctx.targetSends()).toEqual([]);
    await expect(ctx.get<number>("generation")).resolves.toBe(1);
  });

  it("tick() with a matching generation fires the target payload once and self-sends exactly one successor tick", async () => {
    const ctx = new FakeCronCtx("nightly-report");
    const { nextFireAt } = await handleSchedule(ctx, spec);
    const tick1 = ctx.selfSends()[0]!;

    vi.setSystemTime(new Date(nextFireAt));
    const result = await handleTick(ctx, tick1);

    const expectedNext = Date.parse("2026-07-16T10:10:00.000Z");
    expect(result).toEqual({ fired: true, nextFireAt: expectedNext });
    expect(ctx.targetSends()).toEqual([
      { service: "agent.researcher", key: "instance-1", method: "wake", parameter: { kind: "nightly-report" } },
    ]);
    // schedule()'s tick + tick()'s own successor tick = 2 self-sends total.
    expect(ctx.selfSends()).toHaveLength(2);
    expect(ctx.selfSends()[1]).toEqual({ generation: 1, scheduledFor: expectedNext });
  });

  it("tick() ticks repeatedly, one target fire and one self-send per tick, all in the same generation", async () => {
    const ctx = new FakeCronCtx("nightly-report");
    await handleSchedule(ctx, spec);
    let pending = ctx.selfSends()[0]!;

    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(pending.scheduledFor));
      const result = await handleTick(ctx, pending);
      expect(result.fired).toBe(true);
      pending = ctx.selfSends().at(-1)!;
      expect(pending.generation).toBe(1);
    }

    expect(ctx.targetSends()).toHaveLength(3);
  });

  describe("generation guard: unschedule() between a tick's send and its already-queued successor must not resurrect the cron", () => {
    it("a stale tick (from a chain unschedule() has since invalidated) is a pure no-op", async () => {
      const ctx = new FakeCronCtx("nightly-report");
      await handleSchedule(ctx, spec); // generation 1, queues tick A (gen 1)
      const tickA = ctx.selfSends()[0]!;

      // Deliver tick A: fires the target once, and — BEFORE anyone can
      // cancel it — durably queues tick B (gen 1) as its successor.
      vi.setSystemTime(new Date(tickA.scheduledFor));
      await handleTick(ctx, tickA);
      const tickB = ctx.selfSends()[1]!;
      expect(ctx.targetSends()).toHaveLength(1);

      // Now unschedule — strictly BETWEEN tick A's target-send and tick B's
      // delivery. This is the exact race 0001:T2.4 anticipates: tick B is
      // already durably in flight and cannot be individually revoked by a
      // Restate delayed-send API (no such API exists) — the only lever is
      // the generation counter.
      const unscheduleResult = await handleUnschedule(ctx);
      expect(unscheduleResult).toEqual({ generation: 2, wasScheduled: true });
      await expect(ctx.get<unknown>("spec")).resolves.toBeNull();

      // Tick B finally arrives, carrying the now-superseded generation 1.
      vi.setSystemTime(new Date(tickB.scheduledFor));
      const tickBResult = await handleTick(ctx, tickB);

      expect(tickBResult).toEqual({ fired: false, reason: "stale-generation" });
      // The cron must NOT be resurrected: no second target fire, no tick C
      // queued to keep the chain alive.
      expect(ctx.targetSends()).toHaveLength(1);
      expect(ctx.selfSends()).toHaveLength(2); // only A and B — no C
    });

    it("a re-schedule() (replace) between a tick's send and its successor also kills the old chain, while the new one fires independently", async () => {
      const ctx = new FakeCronCtx("nightly-report");
      await handleSchedule(ctx, spec); // generation 1
      const tickA = ctx.selfSends()[0]!;

      vi.setSystemTime(new Date(tickA.scheduledFor));
      await handleTick(ctx, tickA); // fires target once, queues tick B (gen 1)
      const staleTickB = ctx.selfSends()[1]!;

      const newSpec: CronSpec = {
        ...spec,
        target: { service: "agent.researcher", key: "instance-2", handler: "wake" },
      };
      const rescheduleResult = await handleSchedule(ctx, newSpec); // generation 2
      expect(rescheduleResult.generation).toBe(2);
      const tickC = ctx.selfSends().at(-1)!;
      expect(tickC.generation).toBe(2);

      // The old chain's queued tick B still arrives eventually — must be a
      // no-op against the new generation.
      vi.setSystemTime(new Date(staleTickB.scheduledFor));
      const staleResult = await handleTick(ctx, staleTickB);
      expect(staleResult).toEqual({ fired: false, reason: "stale-generation" });
      expect(ctx.targetSends()).toHaveLength(1); // still only instance-1's single fire

      // But the NEW chain's tick fires correctly, against the NEW target.
      vi.setSystemTime(new Date(tickC.scheduledFor));
      const freshResult = await handleTick(ctx, tickC);
      expect(freshResult.fired).toBe(true);
      expect(ctx.targetSends()).toHaveLength(2);
      expect(ctx.targetSends()[1]).toMatchObject({ key: "instance-2" });
    });
  });

  it("unschedule() with nothing scheduled is a harmless idempotent no-op (wasScheduled: false)", async () => {
    const ctx = new FakeCronCtx("never-scheduled");
    const result = await handleUnschedule(ctx);
    expect(result).toEqual({ generation: 1, wasScheduled: false });
    await expect(ctx.get<unknown>("spec")).resolves.toBeNull();
  });

  it("tick() with no spec at all (defensive/unreachable-in-practice path) is a safe no-op", async () => {
    const ctx = new FakeCronCtx("nightly-report");
    // Simulate the generation matching but spec absent — should be
    // unreachable via the real handler pair (handleUnschedule always bumps
    // generation atomically with clearing spec), but guarded defensively.
    ctx.set("generation", 1);
    const result = await handleTick(ctx, { generation: 1, scheduledFor: Date.now() });
    expect(result).toEqual({ fired: false, reason: "no-spec" });
    expect(ctx.sent).toEqual([]);
  });
});
