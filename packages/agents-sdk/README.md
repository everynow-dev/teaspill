# @teaspill/agents-sdk

The developer-facing Agents SDK (T6.1): `defineAgent(...)` compiles a typed
agent definition onto teaspill's coordination agent-object template (a Restate
virtual object, D2); `native(...)`/`claudeAgentSdk(...)` are the D5
harness-selection seam; `serve(...)`/`registerDeployment(...)` stand up the
Restate endpoint and register it through the gateway; the revision helpers
enforce the additive-only state-schema rule; `mintReadToken` issues browser
read tokens (D6).

**Full guide:** [Building agents](https://teaspill.everynow.dev/guides/agents/building-agents) — worked
examples, the platform/workspace tool tables, and the end-to-end
spawn/deploy walkthrough. This README is the package-level orientation; it
links out rather than duplicating that content.

**Worked deployment:** [`@teaspill/reference-deployment`](../reference-deployment/README.md)
(0002:T4.1) is a complete, deployable agent-loop + executor-host built entirely
from this SDK's public surface — the copy-me getting-started example. It shows
`defineAgent` for onWake-only agents and real harness agents, `serve`/register
bootstrap order, the reconciler binding, and every deployment-side seam wired
against public APIs.

Sources: `src/{define-agent,harness,serve,revision,read-token}.ts`.

## `defineAgent`

The primary export. One call per agent type:

```ts
import { defineAgent, native } from "@teaspill/agents-sdk";
import { z } from "zod";

const researcher = defineAgent({
  type: "researcher",                 // realizes Restate service `agent.researcher` (A3)
  spawnSchema: z.object({ topic: z.string() }),
  inboxSchemas: { default: z.object({ note: z.string() }) },
  state: z.object({ findings: z.array(z.string()).default([]) }),
  harness: native({ model: "claude-sonnet-4-5", ingressUrl: "http://restate:8080" }),
  tools: [/* appended after platform + workspace tools */],
  onWake: async (ctx) => { /* optional — see onWake below */ },
});
```

`defineAgent` validates `type` against `^[a-z0-9][a-z0-9_-]{0,47}$`, enforces
the additive-only state-schema rule against an optional `baseline` (see
[revision rules](#revision-rules) below), finalizes the harness selection, and
derives `validateSpawnArgs`/`validateMessage` from `spawnSchema`/
`inboxSchemas` (a bad spawn or inbound payload is a clean `TerminalError`, not
a retry). It returns an `AgentDefinition` with:

- `.compile(deps: CompileDeps)` — builds the live Restate virtual object,
  wiring the deployment's real `outbox`/`notifier`/`archiveCatalog`/etc. seams.
- `.compileConfig(deps)` — the underlying `AgentObjectConfig`, exposed so a
  compiled agent can be driven directly against the coordination handlers in
  tests (fake `ctx`, no real endpoint).
- `.registration()` — the manifest `serve()` registers (type, **revision**,
  harness kind, JSON-Schema'd spawn/state/inbox schemas, tool names).

Full field table (`type`, `revision`, `spawnSchema`, `inboxSchemas`, `state`,
`harness`, `tools`, `onWake`, `baseline`, `tenant`) is in
[the building-agents guide](https://teaspill.everynow.dev/guides/agents/building-agents).

## Harness selection

`harness` is the entire D5 pluggability seam: swap `native(...)` for
`claudeAgentSdk(...)` and nothing else in the definition changes. Both
builders live in `src/harness.ts` and return a `HarnessSpec` that `defineAgent`
finalizes with the developer's tools.

- **`native(config: NativeHarnessConfig)`** — the step-durable pi-ai harness
  (the D5 gold standard): every LLM call is its own journaled `ctx.run`, every
  tool call a real Restate invocation, canonical events commit through the
  outbox at each step boundary. Multi-provider via pi-ai.
- **`claudeAgentSdk(config: ClaudeAgentSdkConfig)`** — the Claude Agent SDK
  harness: the SDK owns the loop, with durable-session continuation and
  cold-rebuild-from-canonical-timeline as the recovery path. The heavy
  `@anthropic-ai/claude-agent-sdk` dependency loads lazily on first run only —
  selecting or compiling a `claudeAgentSdk(...)` agent never loads it.

Both selections assemble the same platform tools (`platformTools()`,
`@teaspill/harness-native`) + workspace tools (`workspaceTools()`) + the
developer's `tools`, each routed through a `ToolContext` bound to the
exactly-once idempotency key `(entityUrl, runId, toolUseId)`. The default
tool-context transport is HTTP-ingress (`httpToolContext`, exported from this
package); both harness configs accept a `toolContext` override for tests.

See [the building-agents guide (harness selection)](https://teaspill.everynow.dev/guides/agents/building-agents)
for the full config tables and the platform/workspace tool reference, and
[`packages/harness-casdk/README.md`](../harness-casdk/README.md) for the CASDK
durability-layer design.

## The `onWake` contract

`onWake?: OnWakeHandler` (re-exported from `@teaspill/coordination` as
`OnWakeHook`) is the per-wake deterministic hook wired through
`compileConfig`. Per **DECISIONS 0001:A10** (resurrection lands; idle
auto-archive default-ON; onWake contract):

> a `defineAgent` `onWake` runs deterministically inside the wake
> (emit/send/spawn/now, journaled), then either HANDLES the wake fully
> (onWake-only ⇒ NO LLM — deterministic conformance agents) or HANDS OFF to
> the static harness (onWake events precede harness output).

Concretely: `onWake` runs *before* the harness, through a journaled
`OnWakeContext` seam. Returning falsy hands off to the harness (its emitted
events precede the harness's own output); returning `{ handled: true }` fully
handles the wake and no LLM runs. This is also how resurrection works — a
message or spawn to an archived entity rehydrates from the catalog
`archived_snapshot` (never the stream) inside the message/spawn handler before
`onWake`/the harness sees it, continuing the seq counter from `head_seq`.

See `work/plans/0001-build-v1/DECISIONS.md` (A10, and A8/the dead-letter Note
it resolves) for the full decision history, and
[the building-agents guide (onWake)](https://teaspill.everynow.dev/guides/agents/building-agents) for a worked
example.

## Registration

`serve({ agents, deps, port?, registration? })` (`src/serve.ts`) compiles each
definition (`.compile(deps)`), binds the resulting Restate objects into a
coordination endpoint alongside cron/steerbox, and listens. When
`registration` is supplied it also calls `registerDeployment`, which POSTs the
deployment URL to the gateway's `/registry/deployments` (forwarded as-is to
Restate's admin API — the URL must be reachable *from inside* the `restate`
container; see
[the self-hosting guide](https://teaspill.everynow.dev/guides/operations/self-hosting)).

`registerDeployment` makes exactly **one** attempt and throws on failure — the
register-before-gateway-up race (retry/backoff + health-wait) is owned by the
`teaspill dev` CLI, which wraps `serve`. `CompileDeps` (`define-agent.ts`) is
where a deployment supplies its real seams: `outbox`, `notifier`,
`directory?`, `archiveCatalog?` (absent ⇒ an archived entity cannot
resurrect), `emitDelta?`, `steerSource?`, and timing knobs
(`idleArchiveDelayMs`, `outboxChunkSize`, `inactivityTimeoutMs`,
`abortTimeoutMs`).

### Additive per-wake config seams (0002:T4.2)

`CompileDeps.emitDelta`/`steerSource` are **per-type** (one instance for the
whole service). Live conformance (0002:T4.2) needed **per-entity** binding, so
`AgentObjectConfig` (coordination) gained additive factory seams — all
optional and default-preserving:

- `steerSourceFactory({ entityId })` / `emitDeltaFactory({ entityId })` —
  per-wake, entity-bound (a per-entity `DeltaInit` needs the `entityId` the
  config-level emitter couldn't stamp; per-entity steer drain needs the
  `entityId` `createHttpSteerSource` requires). When present they take
  precedence over the per-type `steerSource`/`emitDelta`.
- spawn **`workspaceRef`** — a spawn may name the workspace; it is surfaced on
  `HarnessBuildContext.workspaceRef` and `OnWakeContext.workspaceRef` (spawn
  choice wins, private-key fallback otherwise).
- `OnWakeContext.signal` — an `AbortSignal` for the wake, so an `onWake`
  handler (and the long-exec path) is interruptible.

These live on `AgentObjectConfig`, not (yet) `CompileDeps` — the reference
deployment sets them directly on the object returned by `compileConfig(...)`
(see `reference-deployment/src/agent-loop.ts`). Threading them through
`serve()`/`CompileDeps` is an ergonomics follow-up candidate.

## Revision rules

State schemas are **additive-only within a revision** (`src/revision.ts`). A
live agent instance persists state shaped by the revision it was spawned
under; a running deployment may only widen that shape backward-compatibly
(add **optional** fields). Removing a field, changing a field's type, or
adding a **required** field is breaking and requires a new `revision` number —
the bump applies to new instances only; existing instances keep their
revision until they archive.

`defineAgent` enforces this at build time by structurally diffing JSON Schemas
(`diffStateSchema`) against an optional `baseline: { revision, state }`: a
breaking change declared at an unchanged revision throws `StateRevisionError`
loudly, rather than corrupting state silently at runtime. `diffStateSchema`
and `assertStateRevision` are also exported standalone for custom tooling
(e.g. a CI check against a previously-registered manifest).

## Other exports

- `mintReadToken` (`src/read-token.ts`) — mints short-lived HS256 JWTs
  (`{ pfx, iat, exp }`) so a browser can read `/streams/*`/`/shapes/*`
  directly without the developer proxying every read; writes never bypass the
  developer (D6). See [the auth & API keys guide](https://teaspill.everynow.dev/guides/operations/auth-api-keys).
- `createDrizzleArchiveCatalog`, `ArchiveCatalog`, `OnWakeContext`,
  `OnWakeOutcome` — re-exported from `@teaspill/coordination` so a developer
  can wire archival and write `onWake` handlers against types imported from
  this one package.

## Package layout

| File | Contents |
| --- | --- |
| `src/define-agent.ts` | `defineAgent`, `AgentDefinition`, `CompileDeps`, `AgentRegistration` |
| `src/harness.ts` | `native`, `claudeAgentSdk`, `httpToolContext`, harness config types |
| `src/serve.ts` | `serve`, `registerDeployment` |
| `src/revision.ts` | `diffStateSchema`, `assertStateRevision`, `StateRevisionError` |
| `src/read-token.ts` | `mintReadToken` |
| `src/index.ts` | Public export surface (all of the above) |
