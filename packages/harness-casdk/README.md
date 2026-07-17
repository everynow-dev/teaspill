# @teaspill/harness-casdk

The Claude Agent SDK harness (T7.1; tool surface/steering refinement in T7.2,
packaging in T7.3, delta/usage refinement in T7.4). Implements the frozen
`Harness` interface (`@teaspill/harness-native`) with Claude Code semantics
via D5's three durability layers.

SDK pin: `@anthropic-ai/claude-agent-sdk@0.3.211` (bundled CLI `2.1.211`),
exact — never `^`. A version bump requires a new branch in `translation.ts`
and re-validated goldens (`UPDATE_GOLDEN=1 pnpm test`), per R3.

## Design note (T7.1)

### The three layers, as built

1. **Effects** (`tool-seam.ts`) — the harness never executes tools; the CASDK
   subprocess calls them through an in-process MCP server provided by the
   injected `CasdkToolServerFactory` (T7.2 implements the real one; a fake
   ships here). Handlers execute `ToolDefinition`s through a `ToolContext`
   bound to the idempotency key `(entityUrl, runId, toolUseId)` — exactly-once
   under whole-run retry (T3.1 invariant 1). Structured `tool_result.detail`
   is back-filled from the tool layer's own return value via
   `ToolResultDetailSource` (mapping §4.6) because the SDK's MCP boundary
   only echoes content blocks.

2. **Continuation** (`session-store.ts`, `harness.ts`) — a durable session
   per entity, persisted through OUR `CasdkSessionStore` (file store on a
   persistent volume; memory store for tests; object-store impls slot in).
   The SDK sees it through a facade implementing its `@alpha` SessionStore
   (`load`/`append` + `sessionStoreFlush: 'eager'`): `load()` returns the
   stored transcript (uuid-deduped, crash-REPAIRED — dangling `tool_use` gets
   a synthetic error result), `append()` persists the SDK's dual-write mirror
   (~per-frame with eager flush). **WARM PATH IS THE HOT PATH** — validated
   live against the pinned SDK (see below). A retried `ctx.run` re-resumes
   the same session; a `pendingRun` marker in the meta makes the retry re-feed
   the wake wrapped in an explicit restart note (lossless whether or not the
   crashed attempt delivered it).

3. **Truth** (`capture.ts`, `projection.ts`, `translation.ts`) — canonical is
   authority. Capture translates the run's stream into `TimelineEventInit`s
   returned for outbox commit (one message/reasoning per API turn, ids shared
   with the delta channel; unknown records → `opaque`; enumerated chatter
   dropped; `result` usage never double-counted). Cold rebuild projects
   canonical → session JSONL (`selectContextEvents` fold — canonical
   `summarization` always wins; thinking stripped; `opaque(casdk, session/*)`
   replayed verbatim; trailing user events split off as the streaming-input
   feed). The whole mapping lives in ONE file (`translation.ts`) with
   per-version branches; unknown SDK versions throw at construction.

### Trust-but-verify (the seq stamp)

Session meta carries `seqStamp` = the last canonical seq the session
reflects. Warm requires: meta present, pinned SDK version unchanged,
`stamp <= head`, every context-bearing event after the stamp user-feedable
(exactly the pre-committed wake input), transcript present. The stamp is
saved PREDICTIVELY (`head + returnedEvents.length`) before `run` returns; a
crash before the outbox commit leaves `stamp > head` → mismatch → cold
rebuild. Wrong-warm is impossible by construction; the failure mode is only
an unnecessary rebuild. Runtime verification on top: `init.session_id` must
equal the resumed id (silent fresh session → meta cleared + loud throw → the
retry cold-rebuilds); a dropped mirror batch (`mirror_error`) taints the
session → meta cleared → next wake cold-rebuilds.

### Warm-path validation (2026-07-16/17, live, pinned SDK)

The electric spike NEVER validated persistence-across-retries (digest §6 —
its `append()` was a no-op and every wake cold-rebuilt). T7.1 ran the
experiments the digest prescribed, live against `0.3.211`:

- **A — cross-process persistence:** fresh run with a persisting store,
  separate process resumes via `load()` + `resume` → same `session_id`,
  prior-turn recall. PASS.
- **B — mid-run crash:** run aborted mid-tool-loop; separate process
  re-resumed from the mirror and completed the task. PASS.
- **C — dangling tool_use tail** (crash between tool_use and result / dropped
  final batch): repaired at `load()` with a synthetic error result → resume
  continues cleanly, re-issues the tool. PASS.
- **End-to-end harness smoke** (`live.test.ts`, env-gated
  `TEASPILL_CASDK_LIVE=1`): cold wake → commit → WARM wake with recall —
  including streaming input × resume × sessionStore, the combination the
  spike flagged unvalidated. PASS.

Therefore **no cold-rebuild-every-wake degradation was taken**; D5 stands as
written. `forceCold: true` remains as the ops lever to run the sanctioned
degraded mode without a code change. Known residual window: `append()` is a
best-effort mirror (the SDK drops a batch after 3 failed retries) — covered
by the `mirror_error` taint + repair-on-load; worst case is a cold rebuild.
A crash mid-run can leave the session holding assistant progress canonical
never captured (attempt events are discarded on retry); warm resume keeps
that progress in the model's memory, canonical records the retried run —
memory stays a superset of the user-visible timeline (D5's stated bound).

### Goldens (R3)

`golden.test.ts` + `src/__goldens__/<sdk-version>/`: (1) the fixture
timeline's projection is byte-stable against the committed `session.jsonl`;
(2) projection → parsed lines → capture-side inverse equals the canonical
selection **identity-modulo-ids** (`normalizeForGolden` strips regenerable
ids/seqs/ts; `toolUseId` is kept — it is the durable cross-domain id; the
enumerated non-round-tripped fields are `tool_result.detail`/`name` and
`message.from`).

### Injected seams (offline-first testing)

`CasdkSessionStore` (storage), `CasdkSdkClient` (`query()`), 
`CasdkToolServerFactory` (+ `ToolContextFactory`), `emitDelta`,
`SteerSource`, clock/uuid. `testing.ts` ships the fakes (scripted SDK client
emulating init/resume/load/mirror/abort, fixture timeline, deterministic
ids). Everything except `live.test.ts` runs with no CLI, no network, no key.

### Open questions handed forward

- **T7.2:** real MCP server on this seam; toolUseId correlation must happen
  stream-side (MCP `extra.requestId` ≠ `tool_use.id`); steering cadence
  beyond the current turn-boundary drain (mid-turn injection); whether
  PostCompact-only hooks stay sufficient (PostToolUse was NOT needed — the
  stream carries finalized tool events).
- **T7.3 (done — see `PACKAGING.md`):** `Dockerfile` + `docker/` scripts
  package the persistent volume for the file store, CLI + auth env plumbing,
  and a healthcheck that boot-probes the bundled CLI subprocess directly.
  Build+run verified live (Docker was available); one real bug found and
  fixed along the way (a bare `new Promise(() => {})` doesn't hold Node's
  event loop open). Session-file TTL/rotation is tied to entity archival
  (T8.1, now built) — `PACKAGING.md` documents the operational stance.
  (Historical note: T7.3 flagged `@teaspill/agents-sdk`'s `claudeAgentSdk(...)`
  as an unwired stub; T7.2 has since wired it to `createCasdkHarness`.)
- **T7.4:** per-attempt delta/usage reconciliation (attempt id is already
  stamped on deltas and usage); richer usage deltas from
  `message_start`/`message_delta` if live gauges need them.
