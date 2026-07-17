/**
 * `defineAgent` (T6.1) — the developer-facing typed agent definition, compiled
 * onto the coordination agent-object template (`createAgentObject`, T2.1/D2).
 *
 * A developer writes one `defineAgent({ type, spawnSchema, inboxSchemas, state,
 * harness, tools?, onWake? })`. `defineAgent`:
 *
 * 1. validates the type + enforces the additive-only state-schema rule against
 *    an optional deployed `baseline` (revision.ts / PLAN T6.1 Anticipate);
 * 2. finalizes the harness selection (`native(...)` step-durable / the
 *    `claudeAgentSdk(...)` typed stub), assembling platform (T3.3) + workspace
 *    (T4.3) + the developer's tools;
 * 3. derives `validateSpawnArgs` from `spawnSchema` (a bad spawn is a clean
 *    `TerminalError`, rejected at the handler);
 * 4. returns an `AgentDefinition` whose `.compile(deps)` produces the Restate
 *    virtual object (bound with the deployment's real outbox/notifier seams)
 *    and whose `.registration()` yields the manifest `serve()` registers,
 *    carrying the **revision** (T6.1: bump on a breaking state change; old
 *    instances keep their revision until archived).
 *
 * The harness-selection seam is the entire D5 pluggability: swap `native(...)`
 * for `claudeAgentSdk(...)` and nothing else in the definition changes.
 */

import * as restate from "@restatedev/restate-sdk";
import type { ZodType } from "zod";
import { z } from "zod";
import type { JsonValue } from "@teaspill/schema";
import type { AnyToolDefinition, EmitDelta, SteerSource } from "@teaspill/harness-native";
import {
  createAgentObject,
  type AgentMessageInput,
  type AgentNotifier,
  type AgentObject,
  type AgentObjectConfig,
  type ArchiveCatalog,
  type EntityDirectory,
  type OnWakeHandler,
  type ProjectionOutbox,
} from "@teaspill/coordination";
import type { HarnessSpec } from "./harness.js";
import {
  assertStateRevision,
  type StateRevisionBaseline,
  type StateSchemaDiff,
} from "./revision.js";

const TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * A per-wake hook (T6.1 `onWake`, loop-wired in T8.1). Uses coordination's
 * WIDER `OnWakeHandler` contract: it runs INSIDE the wake through the journaled
 * `OnWakeContext` seam (emit canonical events, send/spawn, read the bounded
 * context) and may either HANDLE the wake fully (`{ handled: true }` ⇒ no LLM)
 * or hand off to the harness (falsy ⇒ onWake-then-harness). `compileConfig`
 * forwards it into `AgentObjectConfig.onWake`.
 */
export type OnWakeHook = OnWakeHandler;

export interface DefineAgentInput<Spawn = unknown, State = unknown> {
  /** Agent type — realizes the Restate service `agent.<type>` (A3). */
  type: string;
  /**
   * Schema revision (T6.1). Default 1. Bump when making a BREAKING state-schema
   * change; enforced against `baseline` by the additive-only rule.
   */
  revision?: number;
  /** Zod schema validating spawn args (a bad spawn ⇒ clean rejection). */
  spawnSchema?: ZodType<Spawn>;
  /**
   * Zod schemas for inbound messages, keyed by an application message kind.
   * Carried into the registration manifest as typed metadata (runtime
   * enforcement of arbitrary inbound message shapes is a follow-up — the frozen
   * canonical `message` carries `ContentBlock[]`, so kinds are an app concern).
   */
  inboxSchemas?: Record<string, ZodType>;
  /** Zod schema for the agent's persisted state (D1 bounded state). */
  state: ZodType<State>;
  /** The harness (D5): `native(...)` or `claudeAgentSdk(...)`. */
  harness: HarnessSpec;
  /** Developer tools, appended after the platform + workspace tools. */
  tools?: readonly AnyToolDefinition[];
  /** Optional per-wake hook (T8.1 `OnWakeHandler` — see `OnWakeHook`). */
  onWake?: OnWakeHandler;
  /** The currently-deployed revision + state schema, for the additive-only guard. */
  baseline?: StateRevisionBaseline;
  /** Default tenant for this type's entities. Default `"default"`. */
  tenant?: string;
}

/** Deployment-supplied seams the definition needs to become a live Restate object. */
export interface CompileDeps {
  /** The projection outbox (T2.2 `DurableStreamsProjectionOutbox`, or a stub in tests). */
  outbox: ProjectionOutbox;
  /** The messaging/notify seam (T2.3 `createAgentNotifier`). */
  notifier: AgentNotifier;
  /** Dead-letter directory (T2.3 / D1 catalog), optional. */
  directory?: EntityDirectory;
  /** Override the definition's default tenant. */
  tenant?: string;
  /** Per-wake steerbox drain (T2.6), keyed elsewhere; default: none queued. */
  steerSource?: SteerSource;
  /** Token-delta sink (T5.1); default: no-op. */
  emitDelta?: EmitDelta;
  /**
   * D7 archive-of-record catalog seam (T8.1): persists the `archived_snapshot`
   * at archive time and reads it back for RESURRECTION. Real impl
   * `createDrizzleArchiveCatalog` (coordination). Absent ⇒ an archived entity
   * cannot resurrect (pre-T8.1 behavior). Forwarded into `AgentObjectConfig`.
   */
  archiveCatalog?: ArchiveCatalog;
  idleArchiveDelayMs?: number;
  subscriberNotifyDebounceMs?: number;
  outboxChunkSize?: number;
  inactivityTimeoutMs?: number;
  abortTimeoutMs?: number;
}

/** The manifest `serve()` registers per agent type (carries the revision). */
export interface AgentRegistration {
  type: string;
  revision: number;
  harness: "native" | "casdk";
  /** JSON Schema of the spawn args (null when the agent takes none). */
  spawnSchema: JsonValue | null;
  /** JSON Schema of the persisted state. */
  stateSchema: JsonValue;
  /** JSON Schema per inbox message kind. */
  inboxSchemas: Record<string, JsonValue>;
  /** Tool names exposed to the model (platform + workspace + developer). */
  tools: string[];
}

export interface AgentDefinition<Spawn = unknown, State = unknown> {
  readonly type: string;
  readonly revision: number;
  readonly harnessKind: "native" | "casdk";
  /** Input echo (typed) — useful for composition/testing. */
  readonly input: DefineAgentInput<Spawn, State>;
  /** The additive diff vs the baseline, when a baseline was supplied. */
  readonly stateDiff: StateSchemaDiff | null;
  /** Per-wake hook, if any (forwarded into the compiled config). */
  readonly onWake?: OnWakeHandler;
  /** Build the Restate virtual object, wiring the deployment's seams. */
  compile(deps: CompileDeps): AgentObject;
  /**
   * The `AgentObjectConfig` `compile` feeds to `createAgentObject` — exposed so
   * the compiled agent can be driven directly against the coordination handlers
   * (`handleSpawn`/`handleMessage`) with a fake ctx in tests.
   */
  compileConfig(deps: CompileDeps): AgentObjectConfig;
  /** The registration manifest (revisioned). */
  registration(): AgentRegistration;
}

function toJsonSchema(schema: ZodType): JsonValue {
  return z.toJSONSchema(schema as never, { target: "draft-2020-12" }) as JsonValue;
}

export function defineAgent<Spawn = unknown, State = unknown>(
  def: DefineAgentInput<Spawn, State>,
): AgentDefinition<Spawn, State> {
  if (!TYPE_RE.test(def.type)) {
    throw new Error(`defineAgent: invalid type ${JSON.stringify(def.type)} (must match ${TYPE_RE})`);
  }
  const revision = def.revision ?? 1;

  // Enforce the additive-only rule up front (loud build-time failure).
  const stateDiff = assertStateRevision({
    type: def.type,
    revision,
    state: def.state,
    ...(def.baseline !== undefined && { baseline: def.baseline }),
  });

  const selection = def.harness.finalize(def.tools ?? []);

  // spawnSchema → validateSpawnArgs (bad args ⇒ TerminalError, no retry).
  const spawnSchema = def.spawnSchema;
  const validateSpawnArgs = spawnSchema
    ? (args: JsonValue | undefined): JsonValue | undefined => {
        const parsed = spawnSchema.safeParse(args);
        if (!parsed.success) {
          throw new restate.TerminalError(
            `spawn args invalid for agent ${JSON.stringify(def.type)}: ${parsed.error.message}`,
          );
        }
        return parsed.data as JsonValue | undefined;
      }
    : undefined;

  // inboxSchemas: light validation of PLAIN messages that carry a single JSON
  // text block, when the developer registered a `default` inbox schema. Other
  // shapes pass through (the frozen message carries ContentBlock[]).
  const defaultInbox = def.inboxSchemas?.["default"] ?? def.inboxSchemas?.["message"];
  const validateMessage = defaultInbox
    ? (input: AgentMessageInput): AgentMessageInput => {
        if (input.kind !== undefined && input.kind !== "message") return input;
        const only = input.content.length === 1 ? input.content[0] : undefined;
        if (!only || only.type !== "text") return input;
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(only.text);
        } catch {
          return input; // not a JSON payload — nothing to validate against
        }
        const res = defaultInbox.safeParse(parsedJson);
        if (!res.success) {
          throw new restate.TerminalError(
            `inbound message invalid for agent ${JSON.stringify(def.type)}: ${res.error.message}`,
          );
        }
        return input;
      }
    : undefined;

  const compileConfig = (deps: CompileDeps): AgentObjectConfig => ({
    entityType: def.type,
    tenant: deps.tenant ?? def.tenant ?? "default",
    harness: selection.harness,
    ...(selection.buildHarness !== undefined && { buildHarness: selection.buildHarness }),
    tools: selection.tools,
    outbox: deps.outbox,
    notifier: deps.notifier,
    ...(deps.directory !== undefined && { directory: deps.directory }),
    ...(deps.steerSource !== undefined && { steerSource: deps.steerSource }),
    ...(deps.emitDelta !== undefined && { emitDelta: deps.emitDelta }),
    ...(deps.archiveCatalog !== undefined && { archiveCatalog: deps.archiveCatalog }),
    ...(def.onWake !== undefined && { onWake: def.onWake }),
    ...(validateSpawnArgs !== undefined && { validateSpawnArgs }),
    ...(validateMessage !== undefined && { validateMessage }),
    ...(deps.idleArchiveDelayMs !== undefined && { idleArchiveDelayMs: deps.idleArchiveDelayMs }),
    ...(deps.subscriberNotifyDebounceMs !== undefined && {
      subscriberNotifyDebounceMs: deps.subscriberNotifyDebounceMs,
    }),
    ...(deps.outboxChunkSize !== undefined && { outboxChunkSize: deps.outboxChunkSize }),
    ...(deps.inactivityTimeoutMs !== undefined && { inactivityTimeoutMs: deps.inactivityTimeoutMs }),
    ...(deps.abortTimeoutMs !== undefined && { abortTimeoutMs: deps.abortTimeoutMs }),
  });

  const compile = (deps: CompileDeps): AgentObject => createAgentObject(compileConfig(deps));

  const registration = (): AgentRegistration => ({
    type: def.type,
    revision,
    harness: selection.kind,
    spawnSchema: spawnSchema ? toJsonSchema(spawnSchema) : null,
    stateSchema: toJsonSchema(def.state),
    inboxSchemas: Object.fromEntries(
      Object.entries(def.inboxSchemas ?? {}).map(([k, s]) => [k, toJsonSchema(s)]),
    ),
    tools: selection.tools.map((t) => t.name),
  });

  return {
    type: def.type,
    revision,
    harnessKind: selection.kind,
    input: def,
    stateDiff,
    ...(def.onWake !== undefined && { onWake: def.onWake }),
    compile,
    compileConfig,
    registration,
  };
}
