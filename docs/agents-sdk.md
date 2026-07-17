# Agents SDK guide (`@teaspill/agents-sdk`)

`@teaspill/agents-sdk` is the developer-facing SDK for writing and deploying
agents. You write one `defineAgent({...})` per agent type, pick a harness,
and `serve(...)` compiles each definition onto teaspill's coordination
agent-object template (a Restate virtual object, D2) and registers it through
the gateway.

Sources: `packages/agents-sdk/src/{define-agent,harness,serve,revision,read-token}.ts`,
`packages/harness-native/src/tools.ts` (platform tools) +
`workspace-tools.ts`, DECISIONS D2/D4/D5/A10.

---

## `defineAgent`

```ts
import { defineAgent, native } from "@teaspill/agents-sdk";
import { z } from "zod";

const researcher = defineAgent({
  type: "researcher",                    // realizes Restate service `agent.researcher` (A3)
  spawnSchema: z.object({ topic: z.string() }),
  inboxSchemas: { default: z.object({ note: z.string() }) },
  state: z.object({ findings: z.array(z.string()).default([]) }),
  harness: native({ model: "claude-sonnet-4-5", ingressUrl: "http://restate:8080" }),
  tools: [/* your ToolDefinitions, appended after platform + workspace tools */],
  onWake: async (ctx) => { /* optional deterministic per-wake logic — see below */ },
});
```

| Field          | Meaning                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `type`         | Agent type. Must match `^[a-z0-9][a-z0-9_-]{0,47}$`. Realizes `agent.<type>`.                                    |
| `revision`     | Schema revision (default 1). Bump on a **breaking** state change — see [state revisions](#the-additive-only-state-rule). |
| `spawnSchema`  | Zod schema validating spawn args. A bad spawn is a clean `TerminalError` (no retry), rejected at the handler.    |
| `inboxSchemas` | Zod schemas for inbound messages, keyed by an app message kind. Carried into the registration manifest as typed metadata. A `default`/`message` schema lightly validates a plain single-text-block JSON message. |
| `state`        | Zod schema for the agent's persisted (bounded) state (D1).                                                       |
| `harness`      | The harness selection — `native(...)` or `claudeAgentSdk(...)`. See [harness selection](#harness-selection).     |
| `tools`        | Developer tools, appended **after** the platform + workspace tools.                                              |
| `onWake`       | Optional per-wake hook. See [onWake](#onwake).                                                                   |
| `baseline`     | The currently-deployed revision + state schema, for the additive-only guard.                                    |
| `tenant`       | Default tenant for this type's entities (default `"default"`).                                                   |

`defineAgent` returns an `AgentDefinition` whose `.compile(deps)` produces the
Restate virtual object and whose `.registration()` yields the manifest
`serve()` registers.

---

## Harness selection

The harness-selection seam is the entire D5 pluggability: swap `native(...)`
for `claudeAgentSdk(...)` and **nothing else in the definition changes**.

### `native(...)` — the step-durable pi-ai harness (recommended default)

We own the loop; multi-provider. **Fully step-durable** (D5 gold standard):
every LLM call is its own `ctx.run`, every tool call is a real journaled
Restate invocation, canonical events commit through the outbox at each step
boundary, and the steerbox is drained between steps.

```ts
native({
  model: "claude-sonnet-4-5",       // pi-ai model id or a full Model object
  provider: "anthropic",            // default for string model ids
  systemPrompt: "…",                // API-level system prompt (never timeline history)
  contextBudgetTokens: 150_000,     // crossing it triggers summarization
  maxSteps: 40,                     // hard cap on LLM steps per run
  platform: true,                   // include platform tools (default all; or { include: [...] }, or false)
  workspace: false,                 // include workspace tools (default off unless a workspace is wired)
  ingressUrl: "http://restate:8080",// needed for spawn_agent/send_message to reach other agents
})
```

### `claudeAgentSdk(...)` — the Claude Agent SDK harness

The SDK owns the loop; Claude Code semantics reproduced via three durability
layers (Effects / Continuation / Truth — see the
[harness-casdk README](../packages/harness-casdk/README.md) and
[casdk-mapping.md](./casdk-mapping.md)). Uses **warm durable sessions** as the
intra-run journal; a mismatch or lost session triggers a cold rebuild by
projecting from the canonical timeline.

```ts
claudeAgentSdk({
  model: "claude-sonnet-4-5",
  systemPrompt: "…",                // replaces the Claude Code preset
  sessionStore: "/data/casdk-sessions", // durable session dir on a volume → warm resume.
                                    //   Omit ⇒ in-process memory store (every fresh process cold-rebuilds:
                                    //   the D5-sanctioned degraded mode).
  maxTurns: 30,
  forceCold: false,                 // ops lever: cold-rebuild every wake without a code change
  platform: true,
  workspace: false,
  ingressUrl: "http://restate:8080",
})
```

The heavy `@anthropic-ai/claude-agent-sdk` (CLI subprocess) loads **lazily on
first run only** — selecting/compiling never loads it. SDK pin is exact
(`0.3.211`); a version bump requires re-validated goldens (R3).

> Both selectors expose the same platform + workspace + developer tools and
> route every side-effecting tool through a `ToolContext` bound to the
> exactly-once idempotency key `(entityUrl, runId, toolUseId)`.

---

## The platform tools (and the async-wake model)

Every harness exposes these six coordination tools to the model
(`packages/harness-native/src/tools.ts`). The **load-bearing** thing to
understand is the async-result / wake model — the tool descriptions are
written to teach the model this, and the tests assert on that text:

| Tool                     | What it does                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `spawn_agent(type, args, id?, workspace?)` | Spawns a child and returns its id **IMMEDIATELY**, never its result. The child runs concurrently; its result arrives **later** as a `child_finished` message on a future wake. `id` enables deterministic reattach; `workspace` is fixed at spawn and never switched. |
| `send_message(to, message, mode?)` | Fire-and-forget send to another agent by entity URL; returns on enqueue. `mode: "steer"` injects into the recipient's current run if mid-turn, else degrades to a normal message wake. |
| `list_children()`        | Read-only view of this agent's known children (from the catalog at call time).                               |
| `wait(reason?)`          | Returns **IMMEDIATELY** and yields the turn. **There is no synchronous blocking anywhere in this runtime** — the wake model re-invokes the agent when a relevant message arrives. |
| `finish(result?, summary?)` | Ends the turn and marks the run complete; `result` is reported to the parent as its `child_finished`.      |
| `set_status(status)`     | Updates the agent's short status line; **non-terminal** (the loop continues).                                |

**The mental model:** spawn returns, the result arrives on a *later* wake, and
`wait` does *not* block. Agents never poll or busy-wait — they spawn/send what
they need, call `wait` (or `finish`), and end the turn; the runtime re-wakes
them as a new turn when input arrives.

`wait` / `finish` / `set_status` are *control* tools: they convey their effect
as a machine-readable signal in `tool_result.detail`, which the harness reads
at the tool boundary and applies when it commits the run.

### The workspace tools

Included when a workspace is wired (`workspace: true` on the harness config).
From `packages/harness-native/src/workspace-tools.ts`:

| Tool                                      | What it does                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bash(command, …)`                        | Run a shell command in the agent's workspace; returns the tailed output.                         |
| `read_file(path)`                         | Read a UTF-8 text file from the workspace.                                                        |
| `write_file(path, content)`               | Create/overwrite a file (parent dirs created).                                                   |
| `edit_file(path, old_string, new_string)` | Unique-match-or-fail string replacement.                                                          |
| `ls(path?)`                               | List a workspace directory.                                                                       |

Every side-effecting workspace op routes through the `workspace/<key>`
executor object with the same exactly-once idempotency key. Reads
(`read_file`, `ls`, `edit_file`'s initial read) need no key.

Restrict either toolset per agent via `platform: { include: [...] }` /
`workspace: { include: [...] }` — e.g. a leaf agent that should never spawn.

---

## `onWake`

`onWake` runs **deterministically inside the wake**, through a journaled
`OnWakeContext` seam (emit canonical events, send/spawn, read the bounded
context, read the clock — all journaled). It runs **before** the harness. Two
modes (DECISIONS A10):

- **onWake-then-harness** (return falsy): the hook's emitted events precede the
  harness output, then the static harness runs the LLM as usual.
- **onWake-only** (return `{ handled: true }`): the hook **fully handles** the
  wake and **no LLM runs**. This is how deterministic conformance agents are
  built — pure, testable, no provider call.

```ts
onWake: async (ctx) => {
  if (isPurelyDeterministic(ctx)) {
    await ctx.emit({ type: "message", payload: { /* … */ } });
    return { handled: true };   // no LLM
  }
  // fall through to the harness
},
```

---

## `serve()` and registration

`serve({ agents, deps, ... })` compiles each definition into its Restate
virtual object (wiring the deployment's real outbox/notifier/etc. seams from
`CompileDeps`), binds them into the coordination endpoint (alongside cron +
steerbox), listens, and — when `registration` is given — registers the
deployment through the gateway.

```ts
import { serve } from "@teaspill/agents-sdk";

const handle = await serve({
  agents: [researcher, summarizer],
  deps: { outbox, notifier /*, archiveCatalog, emitDelta, steerSource, … */ },
  port: 9080,
  registration: {
    gatewayUrl: "http://localhost:8787",
    // The URL Restate DIALS for every invocation — forwarded as-is, no rewrite.
    // host-run dev → host.docker.internal; compose-network service → its service name.
    deploymentUrl: "http://host.docker.internal:9080",
    apiKey: process.env.TEASPILL_API_KEY,
  },
});
```

> `registerDeployment` does **one** attempt and throws on failure. The
> register-before-gateway-up race (retry/backoff + gateway-health wait) is
> owned by the `teaspill dev` CLI, which wraps `serve` — use it for local dev.
> See [self-hosting.md](./self-hosting.md#networking-assumptions-read-before-registering-a-service)
> for the `host.docker.internal` rule.

`CompileDeps` supplies the deployment's real seams: `outbox` (the T2.2
`DurableStreamsProjectionOutbox`), `notifier` (T2.3), and optionally
`archiveCatalog` (D7 archive-of-record — `createDrizzleArchiveCatalog`;
**absent ⇒ an archived entity cannot resurrect**), `emitDelta`, `steerSource`,
and timing knobs (`idleArchiveDelayMs`, `outboxChunkSize`, …).

---

## The additive-only state rule

State schemas are **additive-only within a revision**. A live agent instance
persists state shaped by the revision it was spawned under; a running
deployment may only **widen** that shape backward-compatibly (add **optional**
fields). A **breaking** change — removing a field, changing a field's type, or
adding a **required** field — requires a **new revision** (`revision: 2`): the
bump means new instances only; old instances keep their revision until they
archive (D7).

`defineAgent` enforces this at **build time** against a supplied `baseline`, so
the mistake is a loud error, never silent runtime state corruption:

```ts
defineAgent({
  type: "researcher",
  revision: 1,
  state: z.object({ findings: z.array(z.string()) }),
  baseline: { revision: 1, state: prevStateSchema }, // the currently-deployed schema
  // …
});
// Removing/retyping a field, or adding a required one, at revision 1 throws
// StateRevisionError. Adding an OPTIONAL field is fine. Bump to revision 2 for
// a breaking change.
```

Standalone helpers `diffStateSchema` / `assertStateRevision` are exported for
custom tooling.

---

## Minting browser read tokens

`mintReadToken` (re-exported here) issues the short-lived HS256 tokens that let
a browser read `/streams/*` and `/shapes/*` directly. See [auth.md](./auth.md).

---

## End-to-end example

```ts
import { defineAgent, native, serve } from "@teaspill/agents-sdk";
import { z } from "zod";

// 1. Define. A researcher spawns one summarizer child, waits, and finishes
//    when the child reports back.
const summarizer = defineAgent({
  type: "summarizer",
  spawnSchema: z.object({ text: z.string() }),
  state: z.object({}),
  harness: native({ model: "claude-sonnet-4-5", ingressUrl: process.env.RESTATE_INGRESS_URL! }),
});

const researcher = defineAgent({
  type: "researcher",
  spawnSchema: z.object({ topic: z.string() }),
  state: z.object({ summary: z.string().optional() }),
  harness: native({
    model: "claude-sonnet-4-5",
    systemPrompt:
      "Research the topic. Spawn a `summarizer` with your notes, then `wait`. " +
      "When its child_finished arrives, `finish` with the summary.",
    ingressUrl: process.env.RESTATE_INGRESS_URL!,
  }),
});

// 2. Deploy. `deps` carries the deployment's real coordination seams.
await serve({
  agents: [researcher, summarizer],
  deps: platformDeps,           // { outbox, notifier, archiveCatalog, emitDelta, ... }
  port: 9080,
  registration: {
    gatewayUrl: process.env.TEASPILL_GATEWAY_URL!,
    deploymentUrl: "http://host.docker.internal:9080",
    apiKey: process.env.TEASPILL_API_KEY,
  },
});
```

Spawn it from the frontend (`createActionsClient`, see
[frontend-sdk.md](./frontend-sdk.md)) or the CLI:

```sh
teaspill spawn researcher '{"topic":"the history of tea"}'
teaspill logs /t/default/a/researcher/<id> --deltas
```
