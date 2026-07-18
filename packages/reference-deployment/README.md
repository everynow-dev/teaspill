# @teaspill/reference-deployment

The **canonical deployable reference** (0002:T4.1) for teaspill's two
developer-deployed planes (0001:D4): an **agent-loop** service and an
**executor-host** service, plus the compose overlay
([`docker-compose.overlay.yml`](../../docker-compose.overlay.yml)) that adds
both to the base [`docker-compose.yml`](../../docker-compose.yml) stack. This
is simultaneously:

- the **getting-started example** — copy this package to start your own
  deployment; every seam is wired from public package APIs, nothing internal;
- the stack the **live conformance** (0002:T4.2) and **chaos** (0002:T4.3)
  suites run against — it serves the deterministic conformance agents per the
  [conformance-agent contract](../conformance/README.md#conformance-agent-contract-what-the-live-stack-must-deploy);
- the home of the **deployment-side seams** 0001:T6.2 left open, now real:
  the concrete ingress `WorkspaceClient` (with 0002:T3.1 abort→kill), the
  ingress tool clients, and a catalog-backed `listChildren`.

## Getting started (the whole thing)

```sh
# 1. Build everything + the two service bundles (self-contained ESM, like the gateway image)
pnpm -r build
pnpm --filter @teaspill/gateway bundle
pnpm --filter @teaspill/reference-deployment bundle

# 2. Dev auth: the gateway requires an API key for /registry/* (0001:D6).
#    For a fresh dev stack, set a bootstrap key in .env (or mint a real one
#    later with `teaspill keys create` and drop the bootstrap):
cp .env.example .env
echo 'GATEWAY_BOOTSTRAP_API_KEY=tsp_local_dev_only' >> .env
echo 'TEASPILL_API_KEY=tsp_local_dev_only' >> .env
# optional: real demo agents
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env

# 3. Bring the full stack up (base + overlay)
docker compose -f docker-compose.yml -f docker-compose.overlay.yml up -d --build

# — or let the CLI drive it (health-wait + registration retry + log tail):
export COMPOSE_FILE=docker-compose.yml:docker-compose.overlay.yml
teaspill dev --deployment http://agent-loop:9080 --deployment http://executor:9081

# 4. Talk to it
teaspill spawn conformance-echo
teaspill send /a/conformance-echo/<id> '{"text":"hello teaspill"}'
teaspill logs /a/conformance-echo/<id>

# 5. Run the live conformance suite against it (0002:T4.2's job)
TEASPILL_STACK_URL=http://localhost:8787 TEASPILL_STACK_API_KEY=tsp_local_dev_only \
  pnpm --filter @teaspill/conformance test
```

Registration is idempotent BOTH ways: each service self-registers on boot
(listen → gateway-health wait → register with backoff, reusing the CLI's
`waitForHealthy`/`retryWithBackoff`), and `teaspill dev` re-registers the
URLs you pass (`force: true`). Registration always flows through the gateway
`/registry/*` route — never Restate's admin API directly (0001:T0.4).

## What the agent-loop serves

| agent type | kind | behavior |
|---|---|---|
| `conformance-echo` | onWake-only, no LLM | echoes a `{ text }` send as an assistant message (spawn-respond; also the crash-resume / projection-continuity subject) |
| `conformance-fanout-parent` | onWake-only | spawn args `{ n, childType }` ⇒ spawns N children in ONE wake, gathers all `child_finished` (the permanent dropped-parent-wake regression) |
| `conformance-fanout-child` | onWake-only | finishes immediately (feeds the parent's gather) |
| `conformance-long-exec` | onWake-only | `{ command }` send ⇒ REAL workspace exec via the ingress client; finishes only after the exec's awaitable resolves (workspace-exec-durability) |
| `demo-pi` | `native(...)` pi harness | env-gated on `ANTHROPIC_API_KEY`; platform + workspace tools via the reference tool clients |
| `demo-casdk` | `claudeAgentSdk(...)` | additionally opt-in via `TEASPILL_DEMO_CASDK=1` (the SDK runtime is external to the docker bundle — run the agent-loop on the host for this one) |

A missing key/opt-in means the demo agent is **not served** (logged, never a
crash). The onWake-only agents are possible because 0001:A10 loop-wired
`onWake`: a handler returning `{ handled: true }` fully handles the wake with
no LLM anywhere (see `onWakeOnlyHarness()` — hand-off throws a loud,
actionable error).

The agent-loop also binds the **drift reconciler** (0001:A9 / 0002:T2.1) and
kicks `scheduleReconcilers(...)` (0002:T2.2) after serve+register —
generation-guarded, idempotent across restarts, `TEASPILL_RECONCILER=off` to
disable.

### Loose-message normalization

The gateway forwards send bodies verbatim, but the frozen `message` schema
wants `content: ContentBlock[]`. This deployment folds loose bodies
(`{ text }`, `{ command }`, anything JSON) into canonical single-text-block
messages via the `validateMessage` seam (`normalizeLooseMessage` +
`compileLooseConfig`) — copy this pattern if your agents accept shorthand
sends.

## What the executor host serves

Co-located `workspace/<key>` objects + the `executor-host` service
(0001:T4.1), docker adapter (0001:T4.2, 0002:T5.2-hardened) over the
**mounted host Docker socket** — root-equivalent, dev/self-host trust
boundary only ([docs/self-hosting.md](../../docs/self-hosting.md)). Exec
output goes out-of-band to durable-streams (best-effort sink; the journal
carries only `{ exitCode, tail, streamRef }`, 0001:R4).

## The deployment-side seams (0001:T6.2 → real here)

- **`createIngressWorkspaceClient`** — the concrete `WorkspaceClient` over
  Restate ingress: derived per-op idempotency keys (`<toolKey>#w<n>`),
  deterministic exec ids, ensure-on-first-use, and 0002:T3.1's abort→kill via
  `linkExecAbortToKill` (abort fires the workspace `kill` handler for THIS
  exec; the exec then returns a killed outcome — the signal itself never
  crosses the ingress boundary).
- **`createReferenceToolContext`** — wraps the agents-sdk `httpToolContext`
  (idempotency-keyed spawn/send) and completes it: real catalog-backed
  `listChildren` + spawn-time parent-linkage recording (`ChildrenStore` —
  the platform itself never wrote `entities.parent`; see children.ts), and
  the per-tool-call workspace client bound to the entity's private workspace.

## Environment reference

| var | default (overlay) | meaning |
|---|---|---|
| `PORT` | `9080` / `9081` | listen port (agent-loop / executor) |
| `TEASPILL_GATEWAY_URL` | `http://gateway:8787` | health wait + registration |
| `TEASPILL_INGRESS_URL` | `http://restate:8080` | tool clients, workspace client, reconciler scheduling, awakeable resolve |
| `TEASPILL_STREAMS_URL` | `http://durable-streams:4437` | outbox transport / exec-output sink |
| `TEASPILL_DEPLOYMENT_URL` | `http://agent-loop:9080` / `http://executor:9081` | what Restate dials — service name in-network; `http://host.docker.internal:<port>` for host-run (NEVER localhost — [networking doc](../../docs/self-hosting-networking.md) §3) |
| `TEASPILL_API_KEY` | — | gateway API key for `/registry/*` |
| `DATABASE_URL` | synthesized by compose | catalog; absent ⇒ loud DEGRADED mode (no reconciler/resurrection/listChildren) |
| `TEASPILL_MIGRATE` / `TEASPILL_MIGRATIONS_DIR` | `1` / `/app/drizzle` (image) | idempotent catalog migrations on boot |
| `TEASPILL_RECONCILER` | `on` | `off` disables `scheduleReconcilers` |
| `TEASPILL_WORKSPACE_ADAPTER` | `docker` | adapter private workspaces `ensure` with |
| `TEASPILL_EXECUTOR_ADAPTER` | `docker` | executor: `local-unrestricted` opts into host exec (doubly gated) |
| `ANTHROPIC_API_KEY`, `TEASPILL_DEMO_CASDK`, `TEASPILL_DEMO_MODEL`, `TEASPILL_CASDK_SESSION_DIR` | — | demo-agent gating |

## Design notes (0002:T4.1)

- **Bootstrap order is load-bearing** (`bootstrap.ts`, unit-tested): listen →
  gateway-health wait → register → schedule. Registration before health is
  the electric-agents boot-order bug; scheduling before registration 404s on
  service discovery (hence retried).
- **Endpoint assembly is manual** (`createCoordinationEndpoint({ agents,
  reconciler })`) because agents-sdk `serve()` has no reconciler binding yet
  — an ergonomics follow-up candidate.
- **The SDK's fluent endpoint type is not re-exported** (`ServableEndpoint`
  structural view) — materializing it in declaration emit blows up tsc.
- **zod is pinned to 4.1.13** to match `@teaspill/agents-sdk`: mixing a
  second zod copy (schema/harness-native use ^4.4.3) across `defineAgent`'s
  `ZodType` parameters sends tsc into an out-of-memory structural comparison.
  If you copy this package, match agents-sdk's zod version.
- **Live testing lives elsewhere**: this package's suite is offline (the
  conformance agents are driven through the REAL coordination handlers and
  asserted with the REAL conformance scenario checks); one thin
  `overlay.live.test.ts` smoke is gated on `TEASPILL_STACK_URL`. The full
  live/chaos runs are 0002:T4.2/T4.3.
