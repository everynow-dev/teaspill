# @teaspill/chaos

The **failure-injection suite** (T9.1) — the **acceptance test for D2/D3**.

For each of 5 faults it (a) drives a `@teaspill/conformance` scenario, (b)
injects the fault mid-flight (`docker compose kill/stop/up`, or a process
handle), then (c) re-asserts the mapped **D2/D3 invariant** using the
conformance kit's pure `assert*` fns / scenario `check`s — **"assert the
invariant, not just no-crash"** (PLAN §5 T9.1).

This package **builds on `@teaspill/conformance`**: it imports the `SCENARIOS`
registry, the reusable invariant checks (`assertExactlyOnceGapless`,
`assertSeqGapless`, `assertStructural`, …), the live driver
(`createLiveDriver` / `readStackConfig`), and the offline fakes
(`FakeStreamsServer`, `ManualExecAdapter`, `MemoryWorld`). It does not
re-implement any of them — the chaos suite is exactly "conformance scenario +
a fault injected mid-flight, then assert the same invariant still holds".

## The 5 faults → the invariant each asserts

| # | fault | invariant asserted (NOT "no crash") | asserts | offline? | live |
|---|---|---|---|---|---|
| 1 | **agent-loop killed mid-LLM-call** | after re-dispatch the run RESUMES and the timeline has **no duplicate events** — exactly-once + seq-gapless (a completed `ctx.run` isn't re-run; its append dedups) | A1, A4, D3, A6 | ✔ real outbox exactly-once replay (`agent-loop-kill.test.ts`) | kill agent-loop; Restate re-dispatches |
| 2 | **executor killed mid-exec** | the awaitable **times out** (host-unresponsive backstop) → an **`error` event lands** (timeline still gapless) and the workspace is **recoverable on a fresh exec** | A4, D4, A1 | ✔ real `ExecutorHost` awakeable + recovery + error-event gaplessness (`executor-kill.test.ts`) | kill executor mid long-exec |
| 3 | **streams server killed** | runs **PROCEED** (control flow is Restate K/V, not streams — D1); on recovery the outbox **replays from first-unconfirmed** and the reader sees **ZERO seq gaps** | A6, A1, D1, D3 | ✔ real outbox replay + real reducer dedup (`streams-kill.test.ts`) | kill streams mid-run, then `up -d` |
| 4 | **Restate killed** | **full stop**, then **clean resume** with no state corruption — durable K/V (seq counter + outbox) survives, replay is an idempotent no-op, timeline exactly-once + gapless | A4, D2, A1, D3 | ✔ durable-state half: K/V survives a modeled restart, clean idempotent resume (`restate-kill.test.ts`) | `kill restate` (full stop) then `up -d` |
| 5 | **gateway restart mid-long-poll** | the client **resumes via the resumable protocol** — offset re-read through the proxy, **no loss / no duplication** (continuity carried by the protocol, not gateway state) | D6, A1 | — live-only¹ | restart gateway; client re-reads from offset |

¹ **Fault 5 is live-only here on purpose**: this exact invariant is already
exercised **offline** in `packages/gateway/src/r5-streams.test.ts` ("survives a
GATEWAY restart mid-read: resume from offset on the new instance") against a
faithful fake durable-streams upstream. Those gateway test helpers are internal
(not exported), so re-running them here would duplicate private code; instead
fault 5 asserts the invariant **live** against the real proxy and documents the
offline home (a CI self-test verifies that pointer).

**Faults 1–4 have an offline invariant test** that runs in CI against the REAL
coordination / executor primitives + conformance's fakes — so CI actually
exercises the invariant LOGIC (exactly-once, seq-gaplessness, awakeable
timeout, durable resume), not just a skipped shell. **Fault 5 is live-only**
(its offline coverage lives in the gateway package).

## The fault-driver mechanism

The live faults are injected by shelling out to `docker compose` via
`ComposeController` (`docker-faults.ts`):

- `kill <svc>`  → `docker compose kill <svc>`  — abrupt SIGKILL (models a crash)
- `stop <svc>`  → `docker compose stop <svc>`  — graceful stop
- `start <svc>` → `docker compose up -d <svc>` — bring it back
- `restart <svc>` = kill + start; `waitHealthy` polls `docker compose ps`

The three platform services (`durable-streams`, `restate`, `gateway`) are
compose services (D6). The **agent-loop** and **executor** are
developer-deployed (D4); since 0002:T4.1 the default names are the REAL
compose services the reference overlay defines
([`docker-compose.overlay.yml`](../../docker-compose.overlay.yml) +
[`packages/reference-deployment`](../reference-deployment/README.md)) — no
longer placeholders. A different topology (custom compose file, host-run
processes) overrides them via env (below).

## Run it

### Offline (CI — no stack, no docker)

```sh
pnpm --filter @teaspill/chaos typecheck test
```

The offline invariant tests for faults 1–4 always run; the wiring self-test
runs; every LIVE chaos suite `describe.skipIf`s itself out (`readChaosConfig()`
returns `null`) with a clear message. `pnpm test` stays green without a stack.

### Live (real fault injection)

1. Bring up the stack WITH the reference overlay (it deploys the conformance
   agents + executor the faults target — see
   [`packages/reference-deployment`](../reference-deployment/README.md)):

   ```sh
   pnpm --filter @teaspill/gateway bundle
   pnpm --filter @teaspill/reference-deployment bundle
   export COMPOSE_FILE=docker-compose.yml:docker-compose.overlay.yml
   teaspill dev --deployment http://agent-loop:9080 --deployment http://executor:9081
   ```

2. Point the suite at the gateway, **opt in to real process control**, and run:

   ```sh
   TEASPILL_CHAOS=1 \
   TEASPILL_STACK_URL=http://localhost:8080 \
   TEASPILL_STACK_API_KEY=tsp_… \
     pnpm --filter @teaspill/chaos test
   ```

   Both `TEASPILL_CHAOS=1` **and** `TEASPILL_STACK_URL` are required — either
   missing ⇒ the live faults skip. The suite will `docker compose kill/restart`
   real containers, so run it only against a disposable dev stack.

### Environment variables

| var | meaning | default |
|---|---|---|
| `TEASPILL_CHAOS` | opt in to real process/container control (`1`/`true`/`yes`/`on`) | unset ⇒ live faults skip |
| `TEASPILL_STACK_URL` | gateway origin (conformance's gate) | unset ⇒ live faults skip |
| `TEASPILL_STACK_API_KEY` | API key for gateway writes | none |
| `TEASPILL_STACK_TIMEOUT_MS` | per-scenario observation ceiling | `30000` |
| `TEASPILL_CHAOS_COMPOSE` | compose command | `docker compose` |
| `TEASPILL_CHAOS_COMPOSE_DIR` | dir the compose file lives in | `process.cwd()` |
| `TEASPILL_CHAOS_COMPOSE_FILE` | explicit `-f <file>` | none |
| `TEASPILL_CHAOS_STREAMS_SVC` | streams compose service name | `durable-streams` |
| `TEASPILL_CHAOS_RESTATE_SVC` | Restate compose service name | `restate` |
| `TEASPILL_CHAOS_GATEWAY_SVC` | gateway compose service name | `gateway` |
| `TEASPILL_CHAOS_AGENT_LOOP_SVC` | agent-loop service/process name | `agent-loop` |
| `TEASPILL_CHAOS_EXECUTOR_SVC` | executor service/process name | `executor` |

Plus the conformance agent-type overrides (`TEASPILL_CONFORMANCE_*_TYPE`) — see
the conformance README.

## Why this is the D2/D3 acceptance test

Every fault targets a specific durability mechanism and re-asserts the exact
invariant that mechanism exists to uphold:

- **the outbox** (D3, A6 replay-from-first-unconfirmed) — faults 1, 3, 4
- **awakeables** (D4, T4.1) — fault 2
- **Restate durable execution / single-writer K/V** (D2, A4) — faults 1, 4
- **the resumable stream protocol through the gateway** (D6, R5) — fault 5

If all five hold, D2 (coordination = Restate primitives, exactly-once
messaging/replay) and D3 (exactly-once projection, zero seq gaps) are upheld
under failure — which is what "acceptance test for D2/D3" means.
