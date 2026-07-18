import { describe, expect, it, vi } from "vitest";
import { run } from "./cli.js";
import { runDev } from "./commands/dev.js";
import { followLogs } from "./commands/logs.js";
import { resolveConfig } from "./config.js";
import { applyTimelineEvents, initialTimelineState, type EntityRow } from "@teaspill/frontend-sdk";
import { finalizeEvent, type TimelineEvent, type TimelineEventInit } from "@teaspill/schema";
import {
  captureIO,
  emptyTimelineState,
  fakeActionsClient,
  fakeCatalog,
  fakeDeps,
  fakeTimeline,
  type ActionCall,
} from "./fakes.js";

const CONFIG = resolveConfig({}, {});

// ---------------------------------------------------------------------------
// Subcommand parse + dispatch (against fake clients)
// ---------------------------------------------------------------------------

describe("run() dispatch — spawn / send / control drive the actions client", () => {
  it("spawn <type> [args] parses JSON args and calls spawn", async () => {
    const calls: ActionCall[] = [];
    const { deps } = fakeDeps({ createActionsClient: fakeActionsClient(calls).create });
    const code = await run(["spawn", "researcher", '{"topic":"otters"}'], deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("spawn");
    expect(calls[0]!.args[0]).toEqual({ type: "researcher", args: { topic: "otters" } });
  });

  it("spawn --id makes it idempotent (caller-supplied id)", async () => {
    const calls: ActionCall[] = [];
    const { deps } = fakeDeps({ createActionsClient: fakeActionsClient(calls).create });
    await run(["spawn", "researcher", "--id", "r1"], deps);
    expect(calls[0]!.args[0]).toEqual({ type: "researcher", id: "r1" });
  });

  it("send <url> <message> parses JSON and calls send", async () => {
    const calls: ActionCall[] = [];
    const { deps } = fakeDeps({ createActionsClient: fakeActionsClient(calls).create });
    await run(["send", "/a/researcher/r1", '{"say":"hi"}'], deps);
    expect(calls[0]!.method).toBe("send");
    expect(calls[0]!.args[0]).toBe("/a/researcher/r1");
    expect(calls[0]!.args[1]).toEqual({ say: "hi" });
  });

  it("send falls back to a bare string message", async () => {
    const calls: ActionCall[] = [];
    const { deps } = fakeDeps({ createActionsClient: fakeActionsClient(calls).create });
    await run(["send", "/a/researcher/r1", "just words"], deps);
    expect(calls[0]!.args[1]).toBe("just words");
  });

  it("control <url> <verb> calls control with the verb", async () => {
    const calls: ActionCall[] = [];
    const { deps } = fakeDeps({ createActionsClient: fakeActionsClient(calls).create });
    await run(["control", "/a/researcher/r1", "interrupt", "--reason", "stop"], deps);
    expect(calls[0]!.method).toBe("control");
    expect(calls[0]!.args).toEqual(["/a/researcher/r1", "interrupt", "stop"]);
  });

  it("control rejects an unknown verb (returns exit code 1)", async () => {
    const calls: ActionCall[] = [];
    const { deps, io } = fakeDeps({ createActionsClient: fakeActionsClient(calls).create });
    const code = await run(["control", "/a/researcher/r1", "bogus"], deps);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(io.errLines.join("\n")).toContain("unknown control verb");
  });
});

describe("run() dispatch — agents ls reads the catalog", () => {
  const rows: EntityRow[] = [
    {
      url: "/t/default/a/researcher/r1",
      tenant: "default",
      type: "researcher",
      status: "active",
      tags: null,
      parent: null,
      headSeq: 7,
      snapshotOffset: null,
      snapshotStreamOffset: null,
      createdAt: null,
      updatedAt: null,
    },
  ];

  it("lists rows and applies the --type filter", async () => {
    const captured: { lastOptions?: Parameters<ReturnType<typeof fakeCatalog>>[0] } = {};
    const { deps, io } = fakeDeps({ createAgentCatalog: fakeCatalog(rows, captured) });
    const code = await run(["agents", "ls", "--type", "researcher"], deps);
    expect(code).toBe(0);
    expect(captured.lastOptions?.filter).toEqual({ tenant: "default", type: "researcher" });
    expect(io.outLines.join("\n")).toContain("/t/default/a/researcher/r1");
  });

  it("--json emits raw rows", async () => {
    const { deps, io } = fakeDeps({ createAgentCatalog: fakeCatalog(rows) });
    await run(["agents", "ls", "--json"], deps);
    expect(JSON.parse(io.outLines.join("\n"))).toHaveLength(1);
  });
});

describe("run() — help and unknown command", () => {
  it("no args returns 0", async () => {
    const { deps } = fakeDeps();
    expect(await run([], deps)).toBe(0);
  });
  it("an unknown command returns 1", async () => {
    const { deps } = fakeDeps();
    expect(await run(["frobnicate"], deps)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// logs — render a canned event stream
// ---------------------------------------------------------------------------

describe("followLogs renders a canned timeline stream", () => {
  const ENTITY = "/t/default/a/researcher/r1";
  const ts = (s: number): string => new Date(Date.UTC(2026, 6, 17, 12, 0, s)).toISOString();
  const evt = (seq: number, init: Omit<TimelineEventInit, "ts">): TimelineEvent =>
    finalizeEvent({ ...init, ts: ts(seq) } as TimelineEventInit, { entityId: ENTITY, seq });

  it("prints message + tool lines and stops when the stream closes", async () => {
    const events = [
      evt(0, { type: "entity_spawned", payload: { entityType: "researcher", parentId: null } }),
      evt(1, {
        type: "message",
        payload: { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
      }),
    ];
    const s1 = {
      ...emptyTimelineState(),
      timeline: applyTimelineEvents(initialTimelineState(), events),
    };
    const s2 = { ...s1, streamClosed: true };

    const { deps, io } = fakeDeps({ createAgentTimeline: fakeTimeline([s1, s2]) });
    await followLogs(deps, CONFIG, "/a/researcher/r1");

    const out = io.outLines.join("\n");
    expect(out).toContain("spawned researcher");
    expect(out).toContain("user: hello");
    expect(io.errLines.join("\n")).toContain("stream closed");
  });
});

// ---------------------------------------------------------------------------
// dev — the register-before-gateway-up sequencing
// ---------------------------------------------------------------------------

describe("runDev — health-wait then register-with-backoff", () => {
  it("waits on gateway health (fails N times) before registering", async () => {
    let probes = 0;
    const registered: string[] = [];
    const io = captureIO();
    const { deps } = fakeDeps({
      io,
      healthProbe: async () => {
        probes += 1;
        return probes > 3; // unhealthy for 3 attempts, then healthy
      },
      registerDeployment: async (opts) => {
        registered.push(opts.deploymentUrl);
        return { deploymentUrl: opts.deploymentUrl, agents: [], response: {} };
      },
    });

    await runDev(deps, CONFIG, {
      noCompose: true,
      noLogs: true,
      deployment: ["http://host.docker.internal:9080"],
    });

    expect(probes).toBe(4); // 3 failures + 1 success — health gate held
    expect(registered).toEqual(["http://host.docker.internal:9080"]); // registered AFTER healthy
  });

  it("retries registration when the gateway rejects it, then succeeds", async () => {
    let attempts = 0;
    const { deps } = fakeDeps({
      registerDeployment: async (opts) => {
        attempts += 1;
        if (attempts < 3) throw new Error("gateway 503 (not ready)");
        return { deploymentUrl: opts.deploymentUrl, agents: [], response: {} };
      },
    });
    await runDev(deps, CONFIG, { noCompose: true, noLogs: true });
    expect(attempts).toBe(3);
  });

  it("warns (does not rewrite) a localhost deployment URL", async () => {
    const { deps, io } = fakeDeps();
    await runDev(deps, CONFIG, {
      noCompose: true,
      noLogs: true,
      deployment: ["http://localhost:9080"],
    });
    expect(io.errLines.join("\n")).toContain("host.docker.internal");
  });

  it("re-registers on a watch rebuild trigger", async () => {
    let attempts = 0;
    let onChange: (() => void) | undefined;
    const controller = new AbortController();
    const { deps } = fakeDeps({
      registerDeployment: async (opts) => {
        attempts += 1;
        return { deploymentUrl: opts.deploymentUrl, agents: [], response: {} };
      },
      watchForRebuild: (_paths, cb) => {
        onChange = cb;
        return { close: () => {} };
      },
    });

    const p = runDev(
      deps,
      CONFIG,
      { noCompose: true, noLogs: true, watch: true },
      controller.signal,
    );
    // Let the initial register + watcher setup complete.
    await new Promise((r) => setTimeout(r, 0));
    expect(attempts).toBe(1);
    expect(onChange).toBeTypeOf("function");

    onChange!(); // simulate a rebuild
    await new Promise((r) => setTimeout(r, 0));
    expect(attempts).toBe(2);

    controller.abort();
    await p;
  });

  it("throws when compose up exits non-zero", async () => {
    const { deps } = fakeDeps({ composeUp: async () => 1 });
    await expect(runDev(deps, CONFIG, { noLogs: true })).rejects.toThrow(/compose up/);
  });
});

describe("run() propagates a thrown command error as exit code 1", () => {
  it("returns 1 and logs the message", async () => {
    const { deps, io } = fakeDeps({
      createActionsClient: () => {
        throw new Error("boom");
      },
    });
    const code = await run(["spawn", "researcher"], deps);
    expect(code).toBe(1);
    expect(io.errLines.join("\n")).toContain("boom");
    vi.restoreAllMocks();
  });
});
