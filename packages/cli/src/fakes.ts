/**
 * Test doubles for the CLI (0001:T6.2). Injected via `CliDeps` so every subcommand's
 * parse/dispatch, the register retry/backoff, and log rendering run with no
 * live stack. Not part of the shipped build (excluded in tsconfig.build.json).
 */

import type {
  ActionAccepted,
  ActionsClient,
  ActionsClientOptions,
  AgentCatalog,
  AgentCatalogOptions,
  AgentCatalogState,
  AgentTimeline,
  AgentTimelineOptions,
  AgentTimelineState,
  EntityRow,
} from "@teaspill/frontend-sdk";
import type { RegisterDeploymentOptions, RegisterDeploymentResult } from "@teaspill/agents-sdk";
import type { ApiKeyListRow, CreatedApiKey, RevokeResult } from "@teaspill/catalog";
import type { CliDeps, CliIO, KeysStore } from "./deps.js";
import type { RunningProcess } from "./compose.js";

export interface CapturedIO extends CliIO {
  outLines: string[];
  errLines: string[];
}

export function captureIO(): CapturedIO {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

export interface ActionCall {
  method: "spawn" | "send" | "control";
  args: unknown[];
}

export function fakeActionsClient(
  calls: ActionCall[],
  accepted: Partial<ActionAccepted> = {},
): { create: (opts: ActionsClientOptions) => ActionsClient; lastOptions?: ActionsClientOptions } {
  const holder: { lastOptions?: ActionsClientOptions } = {};
  const result: ActionAccepted = {
    url: "/t/default/a/researcher/r1",
    streamPath: "/t/default/agents/researcher/r1/timeline",
    streamUrl: "http://localhost:8787/streams/t/default/agents/researcher/r1/timeline",
    restate: { id: "inv_1" },
    ...accepted,
  };
  const record =
    (method: ActionCall["method"]) =>
    async (...args: unknown[]): Promise<ActionAccepted> => {
      calls.push({ method, args });
      return result;
    };
  const create = (opts: ActionsClientOptions): ActionsClient => {
    holder.lastOptions = opts;
    return {
      spawn: record("spawn"),
      send: record("send"),
      control: record("control"),
      interrupt: (t, reason, o) => record("control")(t, "interrupt", reason, o),
      pause: (t, o) => record("control")(t, "pause", undefined, o),
      resume: (t, o) => record("control")(t, "resume", undefined, o),
      archive: (t, o) => record("control")(t, "archive", undefined, o),
    };
  };
  return { create, ...holder };
}

export function fakeCatalog(
  rows: EntityRow[],
  captured?: { lastOptions?: AgentCatalogOptions },
): (opts: AgentCatalogOptions) => AgentCatalog {
  return (opts) => {
    if (captured !== undefined) captured.lastOptions = opts;
    const state: AgentCatalogState = { rows, isUpToDate: true, lastError: null };
    return {
      getState: () => state,
      subscribe: () => () => {},
      untilReady: () => Promise.resolve(state),
      close: () => {},
    };
  };
}

/** A timeline that emits the given states (in order) after subscribe, then stops. */
export function fakeTimeline(
  states: AgentTimelineState[],
): (url: string | URL, opts?: AgentTimelineOptions) => AgentTimeline {
  return (_url, _opts) => {
    let current: AgentTimelineState = states[0] ?? emptyTimelineState();
    let closed = false;
    return {
      getState: () => current,
      subscribe: (listener) => {
        queueMicrotask(() => {
          for (const s of states) {
            if (closed) break;
            current = s;
            listener(s);
          }
        });
        return () => {
          closed = true;
        };
      },
      untilUpToDate: () => Promise.resolve(current),
      close: () => {
        closed = true;
      },
      closed: Promise.resolve(),
    };
  };
}

export function emptyTimelineState(): AgentTimelineState {
  return {
    timeline: {
      entityId: null,
      spawned: null,
      appliedThroughSeq: -1,
      join: { mode: "replay" },
      entityState: null,
      entityStateSeq: null,
      historyHole: false,
      drift: null,
      driftCount: 0,
      duplicatesDropped: 0,
      skippedPreJoin: 0,
      rejectedRecords: 0,
      deltasDropped: 0,
      runs: [],
      messages: [],
      toolCalls: [],
      reasoning: [],
      children: [],
      controls: [],
      errors: [],
      summarizations: [],
      snapshots: [],
      opaques: [],
      archived: null,
      summarizedThroughSeq: null,
      liveDeltas: {},
      liveUsage: {},
      finalizedRefs: new Set<string>(),
      lastEventTs: null,
    },
    upToDate: false,
    streamOffset: null,
    streamClosed: false,
    parseErrors: 0,
    lastError: null,
  };
}

/**
 * A recording fake KeysStore. Captures the label passed to `create`, the
 * selector passed to `revoke`, and whether `close` ran; returns canned rows.
 * The minted `token` is a real `tsp_`-shaped value so tests can assert format
 * and that it appears (create) / never appears (ls/revoke) in output.
 */
export interface FakeKeysStore extends KeysStore {
  calls: { create: Array<{ label?: string }>; revoke: string[]; list: number; closed: number };
  lastDatabaseUrl?: string;
}

export function fakeKeysStore(
  init: {
    created?: Partial<CreatedApiKey>;
    revoked?: Partial<ApiKeyListRow> & { alreadyRevoked?: boolean };
    list?: ApiKeyListRow[];
  } = {},
): { create: (databaseUrl: string) => FakeKeysStore; store: FakeKeysStore } {
  const calls = { create: [] as Array<{ label?: string }>, revoke: [] as string[], list: 0, closed: 0 };
  const createdAt = init.created?.createdAt ?? new Date("2026-07-18T00:00:00.000Z");
  const store: FakeKeysStore = {
    calls,
    create: async (opts) => {
      calls.create.push(opts);
      return {
        id: init.created?.id ?? "11111111-2222-3333-4444-555555555555",
        token: init.created?.token ?? "tsp_ZmFrZS10b2tlbi1mb3ItdW5pdC10ZXN0cy1vbmx5LTEyMzQ1",
        label: init.created?.label ?? opts.label ?? null,
        createdAt,
      };
    },
    revoke: async (selector): Promise<RevokeResult> => {
      calls.revoke.push(selector);
      return {
        row: {
          id: init.revoked?.id ?? "11111111-2222-3333-4444-555555555555",
          label: init.revoked?.label ?? null,
          createdAt: init.revoked?.createdAt ?? createdAt,
          revokedAt: init.revoked?.revokedAt ?? new Date("2026-07-18T01:00:00.000Z"),
        },
        alreadyRevoked: init.revoked?.alreadyRevoked ?? false,
      };
    },
    list: async () => {
      calls.list += 1;
      return init.list ?? [];
    },
    close: async () => {
      calls.closed += 1;
    },
  };
  const create = (databaseUrl: string): FakeKeysStore => {
    store.lastDatabaseUrl = databaseUrl;
    return store;
  };
  return { create, store };
}

export interface FakeDepsInit {
  io?: CapturedIO;
  createActionsClient?: (opts: ActionsClientOptions) => ActionsClient;
  createAgentCatalog?: (opts: AgentCatalogOptions) => AgentCatalog;
  createAgentTimeline?: (url: string | URL, opts?: AgentTimelineOptions) => AgentTimeline;
  registerDeployment?: (opts: RegisterDeploymentOptions) => Promise<RegisterDeploymentResult>;
  createKeysStore?: (databaseUrl: string) => KeysStore;
  healthProbe?: (gatewayUrl: string) => Promise<boolean>;
  composeUp?: () => Promise<number | null>;
  logsFollow?: () => RunningProcess;
  watchForRebuild?: CliDeps["watchForRebuild"];
}

/** A CliDeps with instant sleep and inert defaults; override what a test needs. */
export function fakeDeps(init: FakeDepsInit = {}): { deps: CliDeps; io: CapturedIO } {
  const io = init.io ?? captureIO();
  const noopProc: RunningProcess = { exit: Promise.resolve(0), kill: () => {} };
  const deps: CliDeps = {
    io,
    exit: () => {},
    sleep: () => Promise.resolve(),
    healthProbe: init.healthProbe ?? (() => Promise.resolve(true)),
    createActionsClient: init.createActionsClient ?? fakeActionsClient([]).create,
    createAgentCatalog: init.createAgentCatalog ?? fakeCatalog([]),
    createAgentTimeline: init.createAgentTimeline ?? fakeTimeline([]),
    registerDeployment:
      init.registerDeployment ??
      ((opts) => Promise.resolve({ deploymentUrl: opts.deploymentUrl, agents: [], response: {} })),
    createKeysStore: init.createKeysStore ?? (() => fakeKeysStore().store),
    compose: {
      up: init.composeUp ?? (() => Promise.resolve(0)),
      logsFollow: init.logsFollow ?? (() => noopProc),
    },
    watchForRebuild: init.watchForRebuild ?? (() => ({ close: () => {} })),
  };
  return { deps, io };
}
