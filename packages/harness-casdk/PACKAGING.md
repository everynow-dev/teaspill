# Packaging (T7.3 — runtime packaging)

A container image variant bundling the CASDK CLI subprocess for a CASDK-harness
agent-loop deployment (work/plans/0001-build-v1/PLAN.md §5 Phase 7, T7.3). Files:

- `Dockerfile` — multi-stage build, produces the runtime image.
- `docker/cli-path.mjs` — resolves the installed CASDK CLI binary path.
- `docker/healthcheck.mjs` — the `HEALTHCHECK` (and build-time smoke) probe.
- `docker/entrypoint.mjs` — EXAMPLE/reference entrypoint (see below — this is
  **not** a production server).

## Build

Build context is the **pnpm workspace root**, not this package directory —
`pnpm deploy` (used inside the build) needs the workspace lockfile plus this
package's in-repo dependencies (`@teaspill/schema`, `@teaspill/harness-native`)
to resolve. From the repo root:

```sh
docker build -f packages/harness-casdk/Dockerfile -t teaspill-harness-casdk .
```

This differs from `packages/gateway/Dockerfile` (T1.2), which consumes a
single pre-bundled `.mjs` built on the host and can use a narrow per-package
context. Here the image build itself runs `pnpm install` + `pnpm deploy`
**inside the linux build container** — this matters because
`@anthropic-ai/claude-agent-sdk`'s CLI binary ships as a set of platform-gated
`optionalDependencies` (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`),
resolved by npm/pnpm's `os`/`cpu` gate at *install* time. Building on a macOS
(or any non-Linux) host still yields the correct Linux binary for the
container's target platform, because install happens inside the build stage,
never on the host. Verified live (see "What was actually run" below): the
build-time smoke step resolved and executed the `linux-arm64` CLI binary
(`2.1.211`) even though the image was built on a Darwin host.

This image is **not** wired into `docker-compose.yml` (T1.1's reference
stack) — it's a standalone runtime-packaging variant a developer's own
agent-loop service builds from (or copies the pattern of).

## Environment variables

| Variable | Read by | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | the bundled CASDK CLI subprocess (ambient) | The CLI subprocess's own Anthropic credential. **Not read or forwarded by any code in this package** — `CasdkHarnessOptions.env` (`src/harness.ts`) is only spread into the SDK's `query()` options when explicitly set; when omitted (the default, including in `docker/entrypoint.mjs`), the SDK spawns the CLI subprocess inheriting the full container process environment, so simply setting this container-level env var is sufficient. Live-verified in this task: an invalid test key produced the expected `Invalid API key` error from the CLI subprocess, confirming ambient inheritance actually reaches it. |
| `TEASPILL_CASDK_MODEL` | `docker/entrypoint.mjs` (example only) | Model id passed to `createCasdkHarness({ model })`. Your own app reads model config however it likes — this var name is this package's example convention, not a contract. |
| `TEASPILL_CASDK_SESSION_DIR` | `docker/entrypoint.mjs`; also set as the image `ENV`/`VOLUME` default (`/data/casdk-sessions`) | Root directory for `createFileSessionStore` (`src/session-store.ts`) — see "Volume + cleanup discipline" below. |
| `TEASPILL_CASDK_ENTITY_ID`, `TEASPILL_CASDK_DEMO_PROMPT` | `docker/entrypoint.mjs` (example only) | Optional: drive one real `harness.run(...)` call at container start as a live smoke test. Omit `TEASPILL_CASDK_DEMO_PROMPT` (the default) to skip the live LLM call and only run the boot checks (volume + CLI resolution). |
| `TEASPILL_GATEWAY_URL`, `TEASPILL_API_KEY` | **your own app**, not this image's default entrypoint | The gateway base URL and gateway API key, matching `@teaspill/cli`'s existing convention (`packages/cli/src/config.ts`) and what `@teaspill/agents-sdk`'s `registerDeployment`/`serve({ registration })` expect (`gatewayUrl`, `apiKey`). See "Gateway registration" below — this is the *gateway's* server-side API key (D6), a **different credential** from the Anthropic API key above. |

There is no gateway-issued Anthropic credential broker in this codebase as of
T7.3 — D6's "API keys at the gateway" governs auth *to the gateway*
(registration, ingress calls), not the CASDK subprocess's own Anthropic
credential. If work/plans/0001-build-v1/PLAN.md's T7.3 line ("API key via gateway-issued secret env")
meant something more specific than "however your deployment platform injects
secrets, name it `ANTHROPIC_API_KEY`" — no such gateway mechanism exists to
wire against. Documented here rather than treated as a D-contradiction: it
doesn't conflict with anything D6 actually specifies, and building a new
credential-broker is out of a Size-S packaging task's scope.

## Healthcheck

`docker/healthcheck.mjs`, wired as the image's `HEALTHCHECK` (30s interval,
15s start period, 3 retries) **and** run once at image *build* time (mirrors
`packages/gateway/Dockerfile`'s `GATEWAY_SMOKE` build-time smoke run — a
broken/missing CLI binary fails the build, not the first container boot).

It resolves the installed platform-specific CLI binary
(`docker/cli-path.mjs`) and runs `claude --version`, requiring a non-empty
stdout and exit 0. Scope is deliberately narrow: this verifies **the bundled
CASDK CLI subprocess itself boots** — the T7.3 packaging invariant — not that
a deployed `defineAgent(...)` app is registered with the gateway or serving
Restate invocations. That's the app's own liveness surface; a real app
serving on `PORT` should add its own `HEALTHCHECK`/readiness route on top of
(or instead of) this one if it needs both.

## Volume + cleanup discipline (session JSONL mirror lifecycle)

The image sets `ENV TEASPILL_CASDK_SESSION_DIR=/data/casdk-sessions` and
declares `VOLUME ["/data/casdk-sessions"]`. Mount durable storage there in
production (a named volume, a bind mount, or a network volume) — this is
`createFileSessionStore`'s root (`src/session-store.ts`), which every entity's
CASDK harness run reads/writes through:

```
<TEASPILL_CASDK_SESSION_DIR>/
  <encodeEntityDir(entityId)>/
    meta.json                 # { sessionId, seqStamp, sdkVersion, idMap, ... }
    sessions/
      <sessionId>.jsonl       # the durable session transcript
```

**Why it must survive restarts:** the store is D5 layer 2 (Continuation).
Losing it only costs a cold rebuild (projection from canonical is always the
recovery path — D5), never data loss or a wrong resume; but the **warm path
is the hot path** (T7.1's validated default), so an ephemeral/`tmpfs`-mounted
directory silently degrades every wake to cold-rebuild-from-canonical
(functionally safe, materially slower/more expensive per run).

**The subprocess always writes a local JSONL mirror** — this is the SDK's own
dual-write behavior (`sessionStoreFlush: 'eager'`, `~append(...)` calls
_persisted verbatim_ by `toSdkSessionStore`, `src/session-store.ts`), not
something this package can turn off. Two things to know operationally:

1. **Growth is append-only from the SDK's side.** `appendLines` (the SDK's
   warm-path mirror) only ever grows a session's `.jsonl` file.
   `replaceLines` (cold projection) is the only path that rewrites a
   transcript wholesale — a cold rebuild is therefore also a natural
   compaction point for that one session's file, but nothing here forces one
   proactively.
2. **No TTL/rotation ships in this package.** T7.1/T7.3 do not implement
   session-file pruning; that's tied to entity lifecycle (work/plans/0001-build-v1/PLAN.md T8.1 —
   archival/resurrection), which is not yet built (`work/plans/0001-build-v1/DECISIONS.md` A8 notes
   idle auto-archive is currently opt-in/disabled pending T8.1's resurrection
   path). Until T8.1 lands and (if) it calls `store.clearMeta`/removes a
   retired entity's session directory on archive, **operators should assume
   this volume grows unboundedly with live-entity count and run duration** and
   plan disk capacity / an out-of-band cleanup job (e.g. delete
   `<entityDir>/` for entities your own catalog/application logic has marked
   archived) accordingly. This is a known, documented gap, not a silent one.

The image runs as the non-root `node` user; `/data/casdk-sessions` is
`chown`'d to `node` at build time so the mounted volume is writable without
extra `USER root` steps at deploy time (a fresh named/bind volume mounted
empty inherits that ownership; a pre-existing volume from a different user
mapping may need `chown` on first use).

## Gateway registration (host.docker.internal stance)

This image's default entrypoint (`docker/entrypoint.mjs`) **does not**
register with the gateway or serve Restate invocations — see "Wiring your
own app" below for why. When you *do* wire registration in your own app, it
follows `work/plans/0001-build-v1/notes/self-hosting-networking.md` §3 exactly like any other
agent-loop service:

- Register the URL Restate itself must be able to reach, **from inside the
  `restate` container** — not `localhost`.
- Running this image as its own compose/orchestrator service on the same
  network as `restate`: register its service name + internal port (e.g.
  `http://your-casdk-service:9080`).
- Running it standalone against a host-run (or otherwise out-of-network)
  Restate/gateway during local dev: register
  `http://host.docker.internal:<port>`, per the documented stance — never
  `http://localhost:<port>` (registers successfully, then fails silently on
  first invocation).

The call shape (`@teaspill/agents-sdk`, already a dependency-of-a-dependency
in this workspace) is:

```ts
import { registerDeployment } from "@teaspill/agents-sdk";

await registerDeployment({
  gatewayUrl: process.env.TEASPILL_GATEWAY_URL ?? "http://localhost:8787",
  deploymentUrl: "http://host.docker.internal:9080", // or your service's own URL
  apiKey: process.env.TEASPILL_API_KEY,
  agents: [/* your defineAgent(...) results */],
});
```

`serve({ agents, deps, registration })` (also `@teaspill/agents-sdk`) does
this for you as part of standing up the Restate endpoint — see its module doc
for the one-attempt-then-throw contract (retry/backoff is `@teaspill/cli`'s
job, T6.2).

## Wiring your own app

`@teaspill/harness-casdk` is a **library implementing the `Harness`
interface** (`@teaspill/harness-native`), not a deployable service — it has
no state schema, spawn schema, or tool list of its own, all of which are
inherently your app's concern via `@teaspill/agents-sdk`'s
`defineAgent({ type, state, harness, tools, ... })` + `serve(...)`. Per
work/plans/0001-build-v1/PLAN.md T7.3 ("this is packaging not logic"), that full wiring belongs in
your app, not this package. Two things worth knowing before you write it:

1. **`@teaspill/agents-sdk`'s `claudeAgentSdk(...)` harness selector
   (`packages/agents-sdk/src/harness.ts`) is wired** (T7.2) to this package's
   `createCasdkHarness` (`src/harness.ts`): `defineAgent({ harness:
   claudeAgentSdk(...) })` builds a real CASDK harness (lazy SDK load). The
   earlier `CASDK_NOT_AVAILABLE` stub is retired. (Historical note: T7.3
   documented the pre-wiring stub state before T7.2 closed the gap.)
2. Building your own `HarnessSpec`/`HarnessSelection` (the types
   `@teaspill/agents-sdk` exports) that wraps `createCasdkHarness` directly
   is possible today and bypasses the gap above, but is real integration
   logic (wiring `HarnessBuildContext`, the T7.2 tool-server seam, etc.) —
   deliberately not attempted in this package's example entrypoint, which
   stays scoped to what T7.3 owns (env/volume/CLI packaging) rather than
   duplicating or prejudging that integration work.

## What this image's default entrypoint actually does

`docker/entrypoint.mjs` (the image's `CMD`) is an **example/reference
script**, not a generic production server:

1. verifies the session volume is present and writable;
2. resolves the bundled CASDK CLI subprocess path (shared logic with the
   healthcheck);
3. if `TEASPILL_CASDK_DEMO_PROMPT` is set, drives one real
   `createCasdkHarness(...).run(...)` call end-to-end against a fresh
   in-memory context — exercising the full env/model/API-key/volume path,
   not just "the binary exists on disk";
4. stays running (so `docker run -d` / an orchestrator's healthcheck has a
   long-lived process to probe, the same shape a real `serve(...)` call's
   listening server would have) until `SIGTERM`/`SIGINT`.

Replace `docker/entrypoint.mjs` (or override `CMD`) with your own
`defineAgent(...)` + `serve(...)` app once you've resolved the gap noted
above.

## What was actually run (T7.3 verification)

Docker was available in this environment, so this was **built and boot-probed
live**, not just syntax-checked:

- `docker build -f packages/harness-casdk/Dockerfile -t teaspill-harness-casdk:test .`
  — succeeded, including the build-time CLI smoke check (resolved and ran the
  `linux-arm64` `claude` binary, reporting `2.1.211`, inside the Linux build
  container on a Darwin host — confirming the platform-optionalDependency
  resolution is genuinely container-target-correct, not host-dependent).
- `docker run -d` + polled `docker inspect .State.Health` — reached
  `healthy` after the configured `start_period`; the healthcheck log recorded
  the same successful `claude --version` probe.
- Volume persistence: wrote a file into a named volume mounted at
  `/data/casdk-sessions`, recreated the container against the same volume,
  confirmed the file survived.
- Env plumbing: ran the entrypoint with `TEASPILL_CASDK_DEMO_PROMPT` set and
  an intentionally-invalid `ANTHROPIC_API_KEY` — the CLI subprocess picked it
  up ambiently (no code in this package forwards it explicitly) and the SDK
  surfaced the expected `Invalid API key` error, proving the credential
  reaches the subprocess end-to-end. **Not tested**: a real successful LLM
  call (no live Anthropic key available in this environment) — the auth
  *failure* path is a strong proxy for the plumbing being correct, but a real
  reply was not observed here.
- `pnpm --filter @teaspill/harness-casdk typecheck test` — clean; 46 passed /
  1 skipped (unchanged from the T7.1 baseline — no `src/` files were
  touched by this task).

Also found and fixed one real bug during boot-probing:
`docker/entrypoint.mjs` originally kept the process alive with
`await new Promise(() => {})`, which does **not** hold Node's event loop open
(no timer/I/O registered) — the container exited 0 immediately despite
correct log output. Fixed with a held `setInterval` + `SIGTERM`/`SIGINT`
handlers.
