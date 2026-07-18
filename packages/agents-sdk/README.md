# @teaspill/agents-sdk

The developer-facing Agents SDK (T6.1): `defineAgent(...)` compiles a typed
agent definition onto teaspill's coordination agent-object template (a Restate
virtual object, D2); `native(...)`/`claudeAgentSdk(...)` are the D5
harness-selection seam; `serve(...)`/`registerDeployment(...)` stand up the
Restate endpoint and register it through the gateway; the revision helpers
enforce the additive-only state-schema rule; `mintReadToken` issues browser
read tokens (D6).

**Full guide:** [`docs/agents-sdk.md`](../../docs/agents-sdk.md) — worked
examples, the platform/workspace tool tables, and the end-to-end
spawn/deploy walkthrough. This README is the package-level orientation; it
links out rather than duplicating that content.

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
[docs/agents-sdk.md](../../docs/agents-sdk.md#defineagent).

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

See [docs/agents-sdk.md § Harness selection](../../docs/agents-sdk.md#harness-selection)
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
[docs/agents-sdk.md § onWake](../../docs/agents-sdk.md#onwake) for a worked
example.

## Registration

`serve({ agents, deps, port?, registration? })` (`src/serve.ts`) compiles each
definition (`.compile(deps)`), binds the resulting Restate objects into a
coordination endpoint alongside cron/steerbox, and listens. When
`registration` is supplied it also calls `registerDeployment`, which POSTs the
deployment URL to the gateway's `/registry/deployments` (forwarded as-is to
Restate's admin API — the URL must be reachable *from inside* the `restate`
container; see
[self-hosting.md](../../docs/self-hosting.md#networking-assumptions-read-before-registering-a-service)).

`registerDeployment` makes exactly **one** attempt and throws on failure — the
register-before-gateway-up race (retry/backoff + health-wait) is owned by the
`teaspill dev` CLI, which wraps `serve`. `CompileDeps` (`define-agent.ts`) is
where a deployment supplies its real seams: `outbox`, `notifier`,
`directory?`, `archiveCatalog?` (absent ⇒ an archived entity cannot
resurrect), `emitDelta?`, `steerSource?`, and timing knobs
(`idleArchiveDelayMs`, `outboxChunkSize`, `inactivityTimeoutMs`,
`abortTimeoutMs`).

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
  developer (D6). See [docs/auth.md](../../docs/auth.md).
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
