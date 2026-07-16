# SPIKE-RESTATE — T2.0 Restate semantics spike

**Status: gate PASSED. No D-decision is contradicted.** Two mandatory implementation constraints fall out (see [Contradictions](#contradictions-with-d-decisions)): agent objects must use `explicitCancellation: true`, and every long `ctx.run` must respect handler timeouts + abort signals or it re-executes in a concurrent zombie loop.

**Environment (all code-verified results reproduced here):** Restate server **1.7.2** (`docker.restate.dev/restatedev/restate:latest`, single node), TypeScript SDK **`@restatedev/restate-sdk@1.16.2`**, Node 22, macOS, 2026-07-17. Spike code: `references/restate-spike/` (gitignored, throwaway). Docs fetched live from docs.restate.dev.

Markers: **[code]** = observed against a running server. **[doc]** = current docs / SDK type declarations only. **[sdk-src]** = read from SDK 1.16.2 source/d.ts.

Reproduce: `docker run -d -p 8080:8080 -p 9070:9070 docker.restate.dev/restatedev/restate:latest`, then in `references/restate-spike/`: `npm i && npx tsx src/services.ts`, register with `curl localhost:9070/deployments -X POST --json '{"uri":"http://host.docker.internal:9080","force":true}'`, drive with curl per the snippets below. Side effects log to `/tmp/spike-effects.log`.

---

## (a) Shared vs exclusive handlers; interrupt delivery; cancel vs in-flight `ctx.run`

### Findings

1. **[code] Shared handlers run truly concurrently with a busy exclusive handler.** While an exclusive `longRun` (5 × 3s `ctx.run` steps) was mid-flight, a shared `probe` on the same key returned in **21 ms**. Exclusive calls queue (a `quick` exclusive call fired mid-run waited ~11 s until `longRun` finished).
2. **[code] Shared handlers see K/V state written by the in-flight exclusive invocation in near-real-time** — `ctx.set` becomes visible as each journal command is processed, not at invocation end. Mid-run probes observed `phase: started` → `completed-step-0` while the run was still going. So an exclusive wake can publish `currentInvocationId`/progress and shared handlers read it live.
3. **[code] A shared handler can cancel the in-flight exclusive invocation.** Pattern: exclusive handler records `ctx.request().id` in K/V at wake start; shared `interrupt` reads it and calls `ctx.cancel(id)`. Verified end to end. (Alternative discovery path, also verified: admin SQL `SELECT id FROM sys_invocation WHERE ...` on `:9070/query`.) Cancelling an already-completed invocation returns 409 "already completed" — harmless, handle it.
4. **[code] Default cancellation semantics (no `explicitCancellation`):**
   - The pending `ctx.run` **await rejects promptly** with `TerminalError` (`[409] Cancelled`) — ~1 s after the cancel in our runs. (Current docs say the error is thrown "once execution finishes"; observed behavior on 1.7.2/SDK 1.16.2 is prompt rejection.)
   - **The closure is NOT aborted — it keeps running as a zombie** to completion; its result is discarded. An LLM call would be fully billed and thrown away.
   - **Cancellation is sticky**: after the first Cancelled error, *every subsequent context await also rejects Cancelled*. A post-cancel `ctx.run` closure still executes, but its await throws, so **multi-step durable cleanup is impossible under default cancellation**. (Verified: `cleanup-1` closure ran, its await threw, `cleanup-2` never ran; trailing `ctx.set`s were skipped and never committed.) Only fire-and-forget `ctx.objectSendClient(...).send(...)` works reliably post-cancel — which is exactly what Restate's own interrupt-regenerate example limits itself to.
5. **[code] `explicitCancellation: true` + `ctx.cancellation()` is the correct interrupt seam** (experimental API, `restate.internal.ContextInternal`, SDK ≥1.16). The SDK stops auto-propagating; you race the run against the cancellation promise and abort your own work via `AbortController`. Verified: **interrupt → in-flight closure aborted in ~20 ms**, then normal durable steps (`ctx.run`), state writes, and a *successful* completion all work. The entity stays immediately messageable. Caveat [code]: the `.map()` callback on the cancellation promise can execute more than once (replay) — keep it idempotent (`controller.abort()` is).
6. **[code] Cancel of a *queued* (not yet started) exclusive invocation removes it from the inbox** — it never executes and leaves no completion record.
7. **[code] Shared handler resolving a "channel": awakeables.** An exclusive handler awaiting an awakeable was resolved externally over HTTP while blocked; `ctx.resolveAwakeable` is available on `ObjectSharedContext` [sdk-src] — same server mechanism. Note [doc]: an exclusive handler blocked on an awakeable queues all other exclusive calls to that key (shared handlers still run).

### Consequence for teaspill

**T2.5 `interrupt` and T2.1 `signal` CAN reach a busy agent object — D2/D8 confirmed.** `interrupt` = shared handler + `ctx.cancel` of the recorded in-flight wake; prompt LLM abort requires `explicitCancellation` (below). Steer status reads (T2.6 "cheap status read") can be a shared handler.

### Recommended pattern (T2.1/T2.5 — the interrupt seam)

```ts
const agent = restate.object({
  name: "agent.mytype",
  handlers: {
    message: async (ctx: restate.ObjectContext, msg: Msg) => {
      ctx.set("currentInvocationId", ctx.request().id); // interrupt target
      const ctxI = ctx as unknown as restate.internal.ContextInternal;
      const abort = new AbortController();
      const interrupted = ctxI.cancellation().map(() => {
        abort.abort();                                 // reaches the live LLM/tool call
        throw new restate.TerminalError("interrupted"); // idempotent map!
      });
      try {
        const result = await restate.RestatePromise.race([
          ctx.run("llm-step", () => llmCall(args, { signal: abort.signal })),
          interrupted,
        ]);
        // ... more steps, outbox flush (T2.2), notify (T2.3) ...
      } catch (e) {
        if (e instanceof restate.TerminalError) {
          // durable steps STILL WORK here (explicitCancellation only):
          await ctx.run("flush-outbox", () => flush(...));
          ctx.set("status", "interrupted");            // commits fine
          return;                                      // completes successfully; entity stays live
        }
        throw e;
      } finally {
        ctx.clear("currentInvocationId");
      }
    },
    interrupt: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => {
      const id = await ctx.get<string>("currentInvocationId");
      if (id) ctx.cancel(id as restate.InvocationId);
      return { interrupted: !!id };
    }),
  },
  options: { explicitCancellation: true }, // MANDATORY for agent objects — see Contradictions
});
```

Risk note: `ctx.cancellation()` / `explicitCancellation` are marked `@experimental` [sdk-src]. Fallback if it regresses: default-cancellation + one-way sends for cleanup (Restate's own documented pattern), accepting zombie LLM spend and single-shot cleanup.

---

## (b) Journal size with large `ctx.run` results; practical payload ceiling (R4)

### Findings (all [code], default server config)

| Size of `ctx.run` result | Outcome |
|---|---|
| 1–8 MiB | Works silently |
| 10–16 MiB | Works, but server logs `Message size warning ... >= 10.0 MiB ... can make the system unstable` (`worker.invoker.message-size-warning`, default 10 MiB) |
| 32 MiB | **Poisoned invocation**: the run completes and commits, but *replay* fails with `RT0001: memory budget exhausted (upper bound exceeded) while reading journal entries: needed 32.0 MiB` → invocation goes to **`paused`** and stays wedged until manual kill/config change |
| Ingress request body | Hard cap **exactly 32 MiB** → HTTP 413 `length limit exceeded` (default `networking.message-size-limit`; `ingress.request-size-limit` clamps to it) |

The 32 MiB failure mode is the nasty one: it fires **after** the expensive work committed, at replay time — and on a **virtual object it would wedge the key's exclusive queue** (every subsequent wake blocked behind a paused invocation). Retention defaults that matter: `default-journal-retention = 1d` [doc].

### Consequence for teaspill

R4 stands, now with numbers. Rules for T2.1/T2.2/T3.2/T4.1:

- **Design budget: keep any single journal entry (ctx.run result, handler arg/return, K/V value) ≤ ~1 MiB**; treat the server's 10 MiB warning as a hard alarm and 32 MiB as a cliff. The gateway's 1 MB body cap (T1.2c) already enforces this at ingress.
- Harness step results carry **summaries/refs**; bulk (stdout, big tool output, token streams) goes to durable streams, journal stores `{ streamRef, offset, tailBytes }` — exactly D2/T4.1's shape.
- If a harness run can produce a large event array, **commit events to the outbox across multiple `ctx.run` steps** rather than returning one giant array (T2.1 anticipate-a, confirmed necessary).
- K/V state is written via the same journal commands, so the same budget applies to the outbox value per write — trim aggressively; one outbox entry per event, not one giant array value, if events can be large.

---

## (c) Idempotency-key semantics on ingress invocations

### Findings

1. **[code] Dedup works as advertised** for `call` and `send`, services and virtual objects: same `idempotency-key` → same invocation id (`PreviouslyAccepted` for sends), cached response replayed, handler executed **once**. Different key → new execution.
2. **[doc] Retention default 24 h**, tunable per handler/service (`idempotencyRetention` in SDK handler options — [code]: registered value visible in admin API) and server-wide (`default-idempotency-retention = 1d`; `max-idempotency-retention` clamp exists since 1.7).
3. **[code] Expiry is lazy — retention is a floor, not a ceiling.** A handler registered with `idempotencyRetention: 5s` still deduped the same key **10+ minutes later** on 1.7.2 single-node. Never design anything that *relies on expiry* to allow re-execution; rely only on "dedup is guaranteed *within* retention".
4. **[code] Retrieval by target works**: `POST /restate/attach` and `/restate/output` with `{"target":"idempotentInvocation", service, (key), handler, idempotencyKey}` return/await the original result — lets the gateway answer client retries without storing invocation ids.
5. **[doc] On retry within retention, Restate returns the first result or attaches you to the still-running invocation** — i.e. latch semantics, not error.
6. **[doc] 1.8+ note:** with the `controlled-idempotent-sharding` cluster feature (default for *new* clusters; not present on our 1.7.2 feature list), the ingress auto-assigns idempotency keys to calls lacking them, and completed invocations are then retained per idempotency retention. Cost/disk consideration for T8.x, not a correctness issue.

### Consequence for teaspill

- **T3.1's `(entityUrl, runId, toolUseId)` contract is sound**: a side-effecting tool call through ingress with that key is exactly-once under whole-run retry, for at least 24 h (default). If a single run's retry horizon could exceed retention, raise `idempotencyRetention` on the workspace/platform tool handlers — cheap, per-handler.
- **T2.2 outbox**: Restate idempotency is *not* the outbox dedup mechanism (that's the durable-streams idempotent producer per D3/A1); Restate keys only shield gateway→agent command ingress from client/gateway retries. No retention coupling. 24 h default is ample for that use.
- Gateway pattern: forward client `Idempotency-Key` headers verbatim; use `/restate/output` by target for read-your-result retries.

---

## (d) Awakeable timeout + cancellation patterns (T4.1)

### Findings (all [code] unless noted)

1. `await promise.orTimeout({ milliseconds: n })` throws a catchable `restate.TimeoutError` — catching it avoids the retry loop; the handler proceeds (returned `{outcome:"timeout"}`).
2. Resolve/reject via HTTP (`/restate/awakeables/{id}/resolve|reject`) and via SDK both work; **reject surfaces as `TerminalError` with the reject reason** in the waiter.
3. **Double-resolution / resolution after timeout or cancellation is accepted (HTTP 202) and silently ignored** — resolvers never need to care whether the waiter is still there.
4. **Awakeables survive service-process crash/restart**: killed the endpoint process while a handler awaited; after restart, resolving the same awakeable id completed the invocation with the payload. IDs are journaled, so retries wait on the same id.
5. **Cancel-while-awaiting works**: cancelling an invocation blocked on an awakeable throws `TerminalError [409] Cancelled` at that await; a cleanup `ctx.run` closure still executed (subject to the sticky-await caveat from (a)-4 under default cancellation).
6. [doc] An exclusive VO handler blocked on an awakeable queues all other exclusive calls to that key — shared handlers still serve.

### Recommended pattern (T4.1 long exec)

```ts
// workspace object, exclusive handler
exec: async (ctx: restate.ObjectContext, cmd: Cmd) => {
  const { id, promise } = ctx.awakeable<ExecResult>();
  await ctx.run("dispatch", () => host.startExec(cmd, { completionToken: id })); // idempotent on host side
  try {
    return await promise.orTimeout({ minutes: cmd.timeoutMin ?? 10 }); // {exitCode, tailBytes, streamRef}
  } catch (e) {
    if (e instanceof restate.TimeoutError) {
      await ctx.run("kill-exec", () => host.kill(cmd.execId));
      throw new restate.TerminalError(`exec timed out`);
    }
    throw e; // incl. Cancelled from the shared kill/interrupt path
  }
},
// shared escape hatch (T4.1-a): reads currentInvocationId from K/V, ctx.cancel()s it,
// and one-way-sends host.kill — same mechanics as (a).
```

Host side resolves with `POST /restate/awakeables/{id}/resolve` — late/duplicate resolutions are safe no-ops.

---

## (e) Replay behavior of completed vs aborted `ctx.run`

### Findings (all [code])

1. **A completed `ctx.run` never re-executes on replay.** Step A ran once while step B failed transiently and retried (A's closure executed exactly once across both attempts; B's twice). Retries replay A's journaled result.
2. **A `ctx.run` aborted mid-flight re-executes from scratch.** SIGKILLed the endpoint process mid-closure; after restart the invocation retried (~7 s), the closure ran again from the top, then completed and was journaled. **`ctx.run` bodies are at-least-once**; only their *committed results* are exactly-once. (This is precisely why T3.1's tool-idempotency contract exists.)
3. **The timeout trap (critical for T3.2/T7.1):** a `ctx.run` whose duration exceeds `inactivityTimeout + abortTimeout` is aborted and retried **forever**: we observed a 30 s "LLM call" (5 s/5 s timeouts) started **6 times**, with aborted attempts' closures continuing as zombies **concurrently overlapping** the retries — up to ~3 closures running simultaneously — and the invocation stuck in `backing-off`/`paused`, never committing. In production terms: an LLM call re-billed every retry interval, plus concurrent duplicate side effects.
4. **Mitigation verified:** `ctx.request().attemptCompletedSignal` (an `AbortSignal`, [sdk-src]) fires when the runtime aborts the attempt; wiring it into the closure's work terminated the zombie immediately and the retry proceeded cleanly.
5. Defaults: `inactivity-timeout = 1m`, `abort-timeout = 10m` [doc]; both settable **per handler** in the SDK (`inactivityTimeout` / `abortTimeout` handler options, server ≥1.4) [code: registered values visible in admin API].

### Rules for T2.5 / T3.2 / T7.1

- Completed steps are stable memory — warm resume (T7.1) can trust every journaled step; only the mid-flight step re-runs. CASDK layer-2 continuation (session resume inside a retried `ctx.run`) is consistent with this: the retried closure runs again, resumes the durable session, and continues.
- **Every LLM/exec handler sets `inactivityTimeout` ≥ max expected step latency** (e.g. 10 m for LLM steps) and a sane `abortTimeout`.
- **Every long `ctx.run` closure must honor two abort signals**: the interrupt `AbortController` from (a), and `ctx.request().attemptCompletedSignal` — merge them (`AbortSignal.any([...])`) and pass to fetch/SDK calls. No naked long promises.
- Retry policy on run blocks (`maxRetryAttempts`, `RetryableError` with `retryAfter`) exists for provider-error classification (T3.2) [doc/sdk-src].

---

## (f) A3 naming: dots in service names, URL-shaped keys

### Findings (all [code])

1. **Server-enforced service-name pattern (from the discovery rejection message, authoritative):** `^([a-zA-Z]|_[a-zA-Z0-9])[a-zA-Z0-9._-]*$` — plus **names starting with `restate` are reserved** (`META0005`). Verified accepted: `agent.acme-bot`, `agent.acme_bot.v2`, `UPPER.case-Mixed_1`. Rejected: leading dot, leading digit, space, `/`, non-ASCII.
2. **Keys are arbitrary strings** — slash-containing paths (`/t/default/a/acme-bot/i-1`), full URLs (`https://ex.com/a/x`) all round-trip via `ctx.key`. In ingress URLs the key **must be percent-encoded** (`%2F`); a raw slash in the path is a 400. SDK/typed clients encode for you.
3. **Footgun: the empty key `""` is accepted** (`/restate/call/steer//echoKey` → key `""`). The gateway must reject empty ids/urls.

### A3 verdict: **CONFIRMED as proposed**, with two constraints

- `agent.<type>` works iff `<type>` is slugified to `[a-zA-Z0-9._-]+` (enforce in `defineAgent`/T6.1; also forbid the whole name starting with `restate`, i.e. no constraint in practice since ours start with `agent.`).
- `steer` keyed by full entity url, `workspace` keyed `<tenant>/<name>`, `cron` keyed `<name>`: all fine; always percent-encode keys in raw HTTP paths (gateway responsibility), and validate non-empty.

---

## Contradictions with D-decisions

**None — the gate passes.** D2's coordination model (interrupt reaching a busy object, shared-handler control surface, delayed sends, awakeable completion) is confirmed feasible as designed. Three findings are **mandatory constraints** (amendment-worthy, but refinements rather than contradictions):

1. **D2/T2.5 refinement — `explicitCancellation: true` is required on agent (and workspace) objects.** Under Restate's *default* cancellation semantics, T2.5's contract ("abort the in-flight harness run … record a control event … leave state consistent") is **not implementable**: post-cancel awaits all rethrow Cancelled, so the outbox flush and state writes after an interrupt would be lost, and the in-flight LLM closure zombies to completion at full cost. With `explicitCancellation` + `ctx.cancellation()` + AbortController the full contract works, verified, with ~20 ms interrupt latency. Accepted risk: the API is `@experimental` in SDK 1.16; pin the SDK version and cover the seam with a conformance test (T6.3) so a semantic change is caught in CI.
2. **D2/R4 refinement — journal-entry budget ≤ ~1 MiB, cliff at 32 MiB.** The 32 MiB overrun failure mode (paused-at-replay, wedging the object key *after* the work committed) justifies enforcing the budget in code (harness truncates/ref-swaps tool results before returning them from `ctx.run`), not just by convention.
3. **T3.2/T7.1 constraint — timeout + zombie discipline.** `ctx.run` bodies are at-least-once and aborted attempts **overlap concurrently** with their retries. Every long step needs: per-handler `inactivityTimeout`/`abortTimeout` sized above the step's worst case, and closures that abort on `AbortSignal.any([interruptSignal, ctx.request().attemptCompletedSignal])`. Without this, a slow LLM call becomes an infinite concurrent re-bill loop.

Minor notes for downstream tasks: idempotency expiry is lazy (floor not ceiling — never rely on expiry); cancel of a completed invocation 409s (handle in `interrupt`); queued invocations can be cancelled cleanly (usable for `pause` draining); empty object key is legal at ingress (gateway must validate); `.map()` callbacks on Restate promises may run more than once (keep idempotent).
