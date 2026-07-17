import { describe, expect, it } from "vitest";
import { z } from "zod";
import { diffStateSchema, assertStateRevision, StateRevisionError } from "./revision.js";

const base = z.object({ a: z.string(), n: z.number() });

describe("diffStateSchema", () => {
  it("adding an OPTIONAL field is additive", () => {
    const next = z.object({ a: z.string(), n: z.number(), extra: z.boolean().optional() });
    const diff = diffStateSchema(base, next);
    expect(diff.additive).toBe(true);
    expect(diff.added).toEqual(["extra"]);
    expect(diff.removed).toEqual([]);
    expect(diff.tightenedRequired).toEqual([]);
  });

  it("adding a REQUIRED field is breaking", () => {
    const next = z.object({ a: z.string(), n: z.number(), extra: z.boolean() });
    const diff = diffStateSchema(base, next);
    expect(diff.additive).toBe(false);
    expect(diff.tightenedRequired).toContain("extra");
  });

  it("removing a field is breaking", () => {
    const next = z.object({ a: z.string() });
    const diff = diffStateSchema(base, next);
    expect(diff.additive).toBe(false);
    expect(diff.removed).toEqual(["n"]);
  });

  it("changing a field's type is breaking", () => {
    const next = z.object({ a: z.number(), n: z.number() });
    const diff = diffStateSchema(base, next);
    expect(diff.additive).toBe(false);
    expect(diff.changed).toEqual(["a"]);
  });

  it("making an optional field required is breaking", () => {
    const prev = z.object({ a: z.string(), b: z.number().optional() });
    const next = z.object({ a: z.string(), b: z.number() });
    const diff = diffStateSchema(prev, next);
    expect(diff.additive).toBe(false);
    expect(diff.tightenedRequired).toContain("b");
  });
});

describe("assertStateRevision (the additive-only rule)", () => {
  it("allows an additive change at the SAME revision", () => {
    const next = z.object({ a: z.string(), n: z.number(), extra: z.boolean().optional() });
    const diff = assertStateRevision({
      type: "x",
      revision: 1,
      state: next,
      baseline: { revision: 1, state: base },
    });
    expect(diff?.additive).toBe(true);
  });

  it("REJECTS a breaking change at the same revision", () => {
    const next = z.object({ a: z.number(), n: z.number() });
    expect(() =>
      assertStateRevision({
        type: "x",
        revision: 1,
        state: next,
        baseline: { revision: 1, state: base },
      }),
    ).toThrow(StateRevisionError);
  });

  it("ALLOWS a breaking change when the revision is bumped (new instances only)", () => {
    const next = z.object({ a: z.number(), n: z.number() });
    expect(() =>
      assertStateRevision({
        type: "x",
        revision: 2,
        state: next,
        baseline: { revision: 1, state: base },
      }),
    ).not.toThrow();
  });

  it("rejects a backwards revision", () => {
    expect(() =>
      assertStateRevision({
        type: "x",
        revision: 0,
        state: base,
        baseline: { revision: 1, state: base },
      }),
    ).toThrow(/backwards/);
  });

  it("no baseline ⇒ first deploy, nothing to enforce", () => {
    expect(assertStateRevision({ type: "x", revision: 1, state: base })).toBeNull();
  });
});
