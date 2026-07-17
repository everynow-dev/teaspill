# @teaspill/conformance

The **conformance kit** (T6.3): a reusable acceptance harness of named
scenarios, each asserting **one D2/D3 invariant** of a running teaspill stack.
Every scenario has a one-sentence invariant, a driver, and a pure `check`.

Two ways every scenario runs:

- **Offline** — against the REAL coordination / executor primitives plus
  faithful fakes (a fake durable-streams server that ports the pinned server's
  producer protocol; the real `ExecutorHost`). These run in CI with **no
  stack**.
- **Live end-to-end** — driving a real stack through the developer surfaces
  (`@teaspill/frontend-sdk` actions → gateway `/api/*`; `createAgentTimeline` →
  gateway `/streams/*`). Gated on `TEASPILL_STACK_URL`; **skipped** when unset.

This kit is also the base **T9.1**'s chaos suite builds on — it imports the
`SCENARIOS` registry, the invariant checks, and the live driver, then re-asserts
the same invariants after injecting faults ("assert the invariant, not just
no-crash").

## Scenarios

| id | invariant | asserts | offline? | live? |
|---|---|---|---|---|
| `spawn-respond` | a spawned agent, sent a message, projects an assistant `message` + a successful `run_finished` | D2, A5 | checker self-test | ✔ |
| `parallel-fanout` | a parent spawning N children in one wake receives ALL N `child_finished` (none dropped/double-counted) — **the upstream dropped-parent-wake regression** | D2, A1 | ✔ (messaging primitives) | ✔ |
| `crash-resume` | a run crashing between append and trim resumes exactly-once and seq-gapless | A1, D3, A6 | ✔ (outbox crash-replay) | ✔ |
| `projection-continuity` | across a streams-server restart the outbox replays from first-unconfirmed; the reader (deduped by seq) sees **zero seq gaps** | A6, A1, D3 | ✔ (outbox + fake streams) | ✔ |
| `workspace-exec-durability` | a long exec's awaitable resolves after the agent-loop replica restarts | D4 | ✔ (executor host awakeable) | ✔ |

## Run it

### Offline (CI — no stack)

```sh
pnpm --filter @teaspill/conformance typecheck test
```

The offline suites always run; the live suites `describe.skipIf` themselves out
with a clear message.

### Live end-to-end

1. Bring up a stack in another terminal (compose + registered agent-loop /
   executor + the conformance agents — see the contract below):

   ```sh
   teaspill dev        # docker-compose up + register local services
   ```

2. Point the kit at the gateway and run:

   ```sh
   TEASPILL_STACK_URL=http://localhost:8080 \
   TEASPILL_STACK_API_KEY=tsp_… \
     pnpm --filter @teaspill/conformance test
   ```

For the two scenarios that require a mid-flight restart
(`projection-continuity`, `workspace-exec-durability`), the restart of the
streams container / agent-loop replica is an **out-of-band operator action**
performed while the scenario runs; the assertion is the reader-visible invariant
across it. (T9.1 automates the fault injection on top of this kit.)

### Environment variables

| var | meaning | default |
|---|---|---|
| `TEASPILL_STACK_URL` | gateway origin; **unset ⇒ all live scenarios skip** | — |
| `TEASPILL_STACK_API_KEY` | API key for gateway writes | none |
| `TEASPILL_STACK_TIMEOUT_MS` | per-scenario observation ceiling | `30000` |
| `TEASPILL_CONFORMANCE_ECHO_TYPE` | agent type for the echo responder | `conformance-echo` |
| `TEASPILL_CONFORMANCE_FANOUT_PARENT_TYPE` | fan-out parent agent type | `conformance-fanout-parent` |
| `TEASPILL_CONFORMANCE_FANOUT_CHILD_TYPE` | fan-out child agent type | `conformance-fanout-child` |
| `TEASPILL_CONFORMANCE_LONG_EXEC_TYPE` | long-exec agent type | `conformance-long-exec` |

## Conformance-agent contract (what the live stack must deploy)

The live scenarios drive whatever agents are registered under the configured
types. A stack under test must deploy agents satisfying:

- **echo** (`conformance-echo`) — on a `send({ text })`, emits an assistant
  `message` echoing the text and a successful `run_finished`.
- **fan-out parent** (`conformance-fanout-parent`) — on spawn with
  `args: { n, childType }`, spawns `n` children of `childType` in one wake and
  gathers all `child_finished`.
- **fan-out child** (`conformance-fanout-child`) — finishes immediately so the
  parent receives a `child_finished`.
- **long-exec** (`conformance-long-exec`) — on a `send({ command })`, runs a
  long workspace exec then finishes (so `run_finished` lands only after the
  exec's awaitable resolves).

> Ready-made `defineAgent` implementations of these are **not yet shipped**:
> deterministic pure-logic agents need the `onWake` hook loop-wired (reserved by
> T6.1, carried to T6.2) rather than an LLM harness. Until then, deploy agents
> matching the contract above. The offline suites cover the same invariants
> against the real primitives in the meantime.

## Reusing the kit (for T9.1 and developers)

```ts
import {
  SCENARIOS,            // registry: metadata + pure `check`, keyed by id
  scenarioById,
  createLiveDriver,     // drive via actions, observe via the timeline
  readStackConfig,
  assertAllChildFinished, assertExactlyOnceGapless, assertSeqGapless, // invariants
  runParallelFanout,    // the offline fan-out regression runner
} from "@teaspill/conformance";

const cfg = readStackConfig();
if (cfg) {
  const driver = createLiveDriver(cfg);
  const spawned = await driver.actions.spawn({ type: cfg.agentTypes.fanoutParent, args: { n: 4 } });
  const events = await driver.observeUntil(spawned.streamUrl, (e) =>
    e.filter((x) => x.type === "child_finished").length >= 4,
  );
  // inject a fault here (T9.1), then re-assert:
  const result = scenarioById("parallel-fanout").check(events, { childIds });
  if (!result.ok) throw new Error(result.violations.join("\n"));
}
```

The `check` functions never throw — they return `{ ok, violations, facts }`, so
a chaos driver can inspect exactly which invariant a fault broke.
