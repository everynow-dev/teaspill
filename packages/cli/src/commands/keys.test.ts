import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runKeys } from "./keys.js";
import { fakeDeps, fakeKeysStore } from "../fakes.js";

const SAVED_DB_URL = process.env.DATABASE_URL;
const TEST_DB_URL = "postgresql://teaspill:teaspill@localhost:5432/teaspill?sslmode=disable";

beforeEach(() => {
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  if (SAVED_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED_DB_URL;
});

describe("teaspill keys create", () => {
  it("prints the plaintext token exactly ONCE and closes the store", async () => {
    const { create, store } = fakeKeysStore({
      created: { id: "aaaa1111-2222-3333-4444-555566667777", token: "tsp_" + "a".repeat(43) },
    });
    const { deps, io } = fakeDeps({ createKeysStore: create });

    await runKeys(deps, "create", undefined, { databaseUrl: TEST_DB_URL, label: "svc" });

    const out = io.outLines.join("\n");
    const occurrences = io.outLines.filter((l) => l.includes("tsp_" + "a".repeat(43))).length;
    expect(occurrences).toBe(1); // printed exactly once
    expect(out).toContain("aaaa1111-2222-3333-4444-555566667777");
    expect(out).toMatch(/shown ONCE/i);
    expect(store.calls.create).toEqual([{ label: "svc" }]);
    expect(store.calls.closed).toBe(1);
    expect(store.lastDatabaseUrl).toBe(TEST_DB_URL);
  });

  it("emits JSON (with the token) under --json", async () => {
    const { create } = fakeKeysStore({
      created: { id: "id-1", token: "tsp_" + "b".repeat(43), label: "svc" },
    });
    const { deps, io } = fakeDeps({ createKeysStore: create });

    await runKeys(deps, "create", undefined, { databaseUrl: TEST_DB_URL, json: true });

    const parsed = JSON.parse(io.outLines.join("\n")) as Record<string, unknown>;
    expect(parsed.id).toBe("id-1");
    expect(parsed.token).toBe("tsp_" + "b".repeat(43));
  });
});

describe("teaspill keys ls", () => {
  it("lists id/label/created/revoked and NEVER emits token material", async () => {
    const { create, store } = fakeKeysStore({
      list: [
        {
          id: "id-active",
          label: "web",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          revokedAt: null,
        },
        {
          id: "id-revoked",
          label: null,
          createdAt: new Date("2026-02-01T00:00:00Z"),
          revokedAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    });
    const { deps, io } = fakeDeps({ createKeysStore: create });

    await runKeys(deps, "ls", undefined, { databaseUrl: TEST_DB_URL });

    const out = io.outLines.join("\n");
    expect(out).toContain("id-active");
    expect(out).toContain("web");
    expect(out).toContain("active");
    expect(out).toContain("id-revoked");
    expect(out).toMatch(/revoked 2026-03-01/);
    expect(out).not.toContain("tsp_"); // no plaintext ever
    expect(store.calls.list).toBe(1);
    expect(store.calls.closed).toBe(1);
  });

  it("handles an empty list", async () => {
    const { create } = fakeKeysStore({ list: [] });
    const { deps, io } = fakeDeps({ createKeysStore: create });
    await runKeys(deps, "list", undefined, { databaseUrl: TEST_DB_URL });
    expect(io.outLines.join("\n")).toContain("(no api keys)");
  });
});

describe("teaspill keys revoke", () => {
  it("revokes by selector and never prints token material", async () => {
    const { create, store } = fakeKeysStore({
      revoked: { id: "id-x", revokedAt: new Date("2026-04-01T00:00:00Z") },
    });
    const { deps, io } = fakeDeps({ createKeysStore: create });

    await runKeys(deps, "revoke", "id-x", { databaseUrl: TEST_DB_URL });

    const out = io.outLines.join("\n");
    expect(store.calls.revoke).toEqual(["id-x"]);
    expect(out).toContain("Revoked key id-x");
    expect(out).not.toContain("tsp_");
    expect(store.calls.closed).toBe(1);
  });

  it("reports an already-revoked key", async () => {
    const { create } = fakeKeysStore({
      revoked: { id: "id-y", revokedAt: new Date("2026-04-01T00:00:00Z"), alreadyRevoked: true },
    });
    const { deps, io } = fakeDeps({ createKeysStore: create });
    await runKeys(deps, "revoke", "id-y", { databaseUrl: TEST_DB_URL });
    expect(io.outLines.join("\n")).toMatch(/already revoked/i);
  });

  it("requires a selector", async () => {
    const { create } = fakeKeysStore();
    const { deps } = fakeDeps({ createKeysStore: create });
    await expect(runKeys(deps, "revoke", undefined, { databaseUrl: TEST_DB_URL })).rejects.toThrow(
      /needs an identifier/,
    );
  });
});

describe("teaspill keys — connection + dispatch", () => {
  it("errors with guidance when no DATABASE_URL is available", async () => {
    const { create } = fakeKeysStore();
    const { deps } = fakeDeps({ createKeysStore: create });
    await expect(runKeys(deps, "ls", undefined, {})).rejects.toThrow(/DATABASE_URL/);
  });

  it("falls back to the DATABASE_URL env var", async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    const { create, store } = fakeKeysStore({ list: [] });
    const { deps } = fakeDeps({ createKeysStore: create });
    await runKeys(deps, "ls", undefined, {});
    expect(store.lastDatabaseUrl).toBe(TEST_DB_URL);
  });

  it("rejects an unknown subcommand", async () => {
    const { create } = fakeKeysStore();
    const { deps } = fakeDeps({ createKeysStore: create });
    await expect(runKeys(deps, "rotate", undefined, { databaseUrl: TEST_DB_URL })).rejects.toThrow(
      /unknown keys subcommand/,
    );
  });
});
