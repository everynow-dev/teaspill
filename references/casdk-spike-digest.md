# CASDK spike digest — durable sessions, repair, precompaction, min-viable config

**T7.0 deliverable.** This is what T7.1/T7.2 receive; they should not need to
open `../electric` except via the file-path pointers below. It **complements**
`docs/casdk-mapping.md` (the T0.1/T7.1 event-mapping paper-mapping produced in
G2) — that document owns the CASDK-stream ↔ canonical-event translation table
and is not repeated here. This digest covers everything else the spike
learned: session-store mechanics, crash repair, compaction interop, the
minimum headless config, usage accounting internals, and — most importantly —
**where the spike's architecture diverges from what D5 assumes**, which is a
flagged HALT candidate for T7.1 (see §6).

`../electric` is present. The CASDK spike is the **fully staged, uncommitted**
working tree (`git -C ../electric diff --cached --stat`: 47 files, +13,456/−81
across `packages/agents-runtime/src/claude/` [11 files], its tests [21 files +
5 fixtures], `CLAUDE_AGENT_SDK_PLAN.md`, and small edits to
`context-factory.ts`/`types.ts`/`model-provider-error.ts`/`pi-adapter.ts`).
`git -C ../electric status --porcelain` shows the same set as `A`/`M`. Nothing
in `../electric` was modified to produce this digest.

## 0. Header — pinned version & SESSION_FORMAT min-contract

- **SDK:** `@anthropic-ai/claude-agent-sdk@0.3.211` (exact-pinned, never `^`).
  **Bundled CLI:** `2.1.211`. Confirmed in `CLAUDE_AGENT_SDK_PLAN.md` Task 0.1
  annotation and `../electric/packages/agents-runtime/test/claude-format-version.test.ts`
  (hard-asserts both at test time; treat a mismatch as "re-run the Task 0.4
  experiment and update SESSION_FORMAT.md before trusting anything below").
  Matches `docs/casdk-mapping.md`'s header — same pin, one source of truth.
- **SDK `SessionStore` API stability: `@alpha`** in 0.3.211 (Task 0.2 finding).
  Treat as churn-prone; not yet a stable public contract upstream.
- **SESSION_FORMAT.md min-contract** (`../electric/packages/agents-runtime/src/claude/SESSION_FORMAT.md`,
  live-validated 2026-07-16 against the real CLI): a resumable session line
  needs exactly `{ type: 'user'|'assistant', message: <Anthropic-shaped>, timestamp: <valid ISO, monotonic> }`
  — that triple is the **only** hard requirement (missing/garbage `timestamp`
  → `No conversation found`, everything else droppable). `uuid` +
  `parentUuid` (chained, `null` first) are not enforced but strongly
  recommended: their absence made the model hedge ("no verified tool result")
  in 3 of 4 runs; correctness of the chain is *not* checked (garbage parents
  resume clean) but presence matters. Four line shapes cover everything: user
  text, assistant text, assistant `tool_use` (MCP-qualified name
  `mcp__<server>__<tool>`), user `tool_result` (`is_error` omitted on
  success). One content block per assistant line (native CLI behavior;
  multi-block synthesis untested). Thinking blocks are never synthesized
  (signatures are unforgeable and turn-bound — see `docs/casdk-mapping.md` §4.5,
  same finding, not repeated here). Full experiment matrix (9 field-dropping
  variants, all pass/fail outcomes) is in SESSION_FORMAT.md §"Experiment
  matrix" — worth reading directly if T7.1 needs to justify a schema choice.

## 1. Findings — how the pieces actually work

### 1.1 Durable session storage: SessionStore API vs session files; keying; where a seq stamp would live

The spike **did not implement a persistent session store** — this is the
single most load-bearing fact for T7.1 and is expanded in §6. What it *did*
build and validate, mechanically:

- **Two working lenses**, both live-verified: (a) a custom `SessionStore`
  object passed as `options.sessionStore` with a fresh `options.resume: <uuid>`
  each call — the chosen architecture; (b) writing a real JSONL file under
  `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl` and resuming
  by id with no store — documented fallback ("plan B"), fully working, kept
  only as a contingency note.
- **`SessionStore.load(key)`** (`key: { projectKey, sessionId, subpath? }`) is
  called **exactly once, pre-spawn**, before the CLI subprocess exists. The
  SDK materializes whatever `load()` returns to a **temp file**
  (`tmpdir()/claude-resume-<rand>/projects/<projectKey>/<sid>.jsonl`) and
  **overrides the subprocess's `CLAUDE_CONFIG_DIR`** to that temp dir — which
  also bridges auth (`.credentials.json`/Keychain, `.claude.json`) into the
  temp dir automatically. This means: our own `options.env.CLAUDE_CONFIG_DIR`
  is *never* set by the adapter (setting one breaks the store-materialized
  auth bridge) — confirmed at `claude-adapter.ts` and asserted in
  `test/claude-adapter-lifecycle.test.ts` (`expect(o.env.CLAUDE_CONFIG_DIR).toBeUndefined()`).
- **`SessionStore.append(key, entries)`** is called with **only the new
  turn's lines** (never the loaded prefix), batched (content lines first,
  then `last-prompt`/`mode` meta lines). This is a **dual-write mirror**: the
  subprocess *also* writes its own local JSONL regardless (`persistSession`
  cannot be disabled) — our store's `append()` is a second, optional sink,
  not the only record.
- **Keying:** `projectKey` = sanitized `cwd` (non-alphanumeric → `-`),
  truncated at 200 chars + base36 hash suffix if longer (the SDK computes
  this — a hand-rolled regex-only encoder, as plan-B's file path uses, is
  only valid ≤200 chars). `sessionId` inside content lines and the store
  key/filename **do not need to match** — verified independently (Task 0.4);
  the external key is authoritative.
- **Where a seq stamp would live (D5 layer 3):** nowhere yet — the spike
  never persisted a stamp because it never persisted a session at all (every
  wake mints `sessionId = randomUUID()` fresh — see
  `buildSessionInput` in `claude-session-store.ts:161-178`). T7.1 will need
  to invent this: the natural home is session metadata alongside whatever
  backs `append()`/`load()` once it's made real (e.g. a K/V entry keyed by
  entity url storing `{ lastSeq, sessionId, projectKey }` next to the actual
  entry array).
- **File-path pointer:** `../electric/packages/agents-runtime/src/claude/claude-session-store.ts`
  (179 lines) — `buildSessionEntries()` (:65-83, the entry-array synthesizer),
  `ElectricSessionStore` class (:92-129, `load()`/`append()`), `buildSessionInput()`
  (:161-178, the pipeline entry point: repair → history-policy → convert →
  store). Companion doc: `SESSION_FORMAT.md` §"Resume mechanics worth
  knowing".

### 1.2 Repair (`claude-repair.ts`): dangling tool calls / session damage

Pure function `repairDanglingToolCalls(messages: LLMMessage[]): LLMMessage[]`
(`../electric/packages/agents-runtime/src/claude/claude-repair.ts:79-134`), run
**first** in the `buildSessionInput` pipeline (before history-policy, before
conversion) because the Anthropic Messages API rejects any conversation where
a `tool_use` block isn't answered by a `tool_result` in the very next user
turn — and a crash between "model asked for a tool" and "tool result
recorded" is exactly the shape a mid-run crash leaves behind.

Two passes, non-mutating (returns a new array):
1. **Drop orphan `tool_result`s** — any `tool_result` with no *preceding*
   `tool_call` for the same id (forward scan) is dropped with a
   `runtimeLog.warn`. Catches out-of-order or duplicated results.
2. **Synthesize error results for dangling `tool_call`s** — any `tool_call`
   that never received a result (including one that is the *last* message in
   history) gets a synthetic
   `{ role: 'tool_result', isError: true, content: '[tool execution interrupted: process restarted]' }`
   inserted immediately after it.

Net effect: every `tool_call` is paired, every `tool_result` is anchored,
before the history ever reaches the converter. Tested by cutting a healthy
fixture history at **every possible prefix position** and asserting the
result is always API-valid (`test/claude-repair.test.ts`, 17 tests +
`assertPairedHistory`/`assertApiValid` invariant checkers).

**Flagged in the spike's own comments, not fixed there:** the pi harness's
`toAgentHistory` (`pi-adapter.ts`) performs **no equivalent repair** — a
dangling `tool_call` reaches pi-ai unpaired if it survives budget-driven
dropping. The spike explicitly did not touch the pi path (out of scope for
that task) but flagged it as a latent bug for humans to decide on. **Relevant
to T3.2 (pi-ai harness)** — teaspill's pi-ai harness should decide explicitly
whether it needs the same repair pass rather than inheriting electric's
unaddressed gap silently.

### 1.3 Precompaction (`claude-precompaction.ts`) + history-policy vs CASDK's own compaction

Two *separate* mechanisms sit on either side of a CASDK run, both feeding the
same "compaction checkpoint" contract:

- **`claude-history-policy.ts`** (`applyHistoryPolicy`, 161-184) runs on
  *every* wake, just before conversion. It is a defensive filter, not a
  compaction mechanism: strips any `system`/`reasoning`/`thinking`-shaped
  message or content block that should structurally be unreachable (electric's
  `LLMMessage` type has no reasoning role/block at all — reasoning is
  display-only, written to the stream for UI but never read by the path that
  builds LLM history; traced through `timelineToMessages` →
  `buildEntityTimelineData` → `buildIncludesRuns`, which reads `texts`,
  `toolCalls`, `steps`, `errors` only). The filter exists anyway because
  `LLMMessage[]` crosses a package boundary with only compile-time typing to
  protect it. **Relevant finding for T7.1/schema:** this independently
  confirms `docs/casdk-mapping.md`'s stance that `reasoning` is deliberately
  display-only and never round-trips into synthesized session content — two
  independent codebases arrived at the same conclusion for the same reason
  (unforgeable, turn-bound signatures).
- **`claude-precompaction.ts`** (`maybePrecompactClaudeHistory`, 190-248) is a
  **pre-run guard**, independent of and a backstop for CASDK's own auto-compaction.
  Before a run starts, it estimates token count of the converted history
  (`estimateHistoryTokens`) against a ceiling (`ELECTRIC_AGENTS_COMPACT_CEILING`,
  same knob the pi harness's own compactor uses) and a per-model context
  window (`resolveContextWindow` from `claude-usage.ts`, defaulting to 200K if
  unknown). If over ceiling: summarize the *whole* history via an injected
  `summarize` fn (defaults to electric's existing anthropic summarizer),
  write a `COMPACTION_CHECKPOINT` row through the *same* contract pi's
  mid-turn compactor uses, and replace in-memory history with a single folded
  summary message before the session is even synthesized. **Never fatal**: a
  summarizer failure (e.g. an unknown model id — the pi-ai model registry
  used for summarization doesn't yet know the newest flagship ids) is logged
  loudly and the run proceeds un-folded, relying on CASDK's own auto-compaction
  + the mid-run capture below as the backstop. Confirmed **wired live** in
  `context-factory.ts:956-971` (not just written and unused — grep-verified).
- **CASDK's own auto-compaction, captured mid-run (Task 6.1, `claude-adapter.ts`):**
  the SDK emits a `system`/`compact_boundary` message with **metadata only**
  (`trigger`, `pre_tokens`, `post_tokens` — no summary text, verified against
  `sdk.d.ts` 0.3.211). The **only** place the SDK exposes the actual summary
  text is the **`PostCompact` hook** (`hook_event_name: 'PostCompact'`,
  payload field `compact_summary: string`), a *programmatic* in-process hook
  registered via `Options.hooks` — independent of `settingSources: []`
  (which only excludes *user-config* hooks). The adapter registers this hook
  **only when a persistence sink is supplied** (`ClaudeAdapterOptions.writeCompaction?`),
  guards against firing after the run settled, rejects empty/whitespace
  summaries (a checkpoint hiding history behind nothing is worse than no
  checkpoint), and never lets a throwing sink crash the run. Persisted through
  the identical `COMPACTION_CHECKPOINT` contract as the pre-run guard and pi's
  own compactor — **all three converge on one electric-schema row shape**, a
  pattern directly reusable for teaspill's canonical `summarization` event.
  **Fold-granularity finding, relevant to D5 layer 3:** a whole *run*
  materializes as one timeline item at its earliest order — so if compaction
  happens mid-run, the entire run (including steps *after* the compaction
  point) folds wholesale on the *next* wake's projection. This is identical
  to how pi's own mid-turn compaction folds and is exactly the case
  `docs/casdk-mapping.md` §4.3/§2 already covers for canonical `summarization`
  — **not a new edge case, confirms the existing mapping decision** (canonical
  `summarization` always wins on cold rebuild, verified from two independent
  angles).
- **`docs/casdk-mapping.md` already covers** the boundary→summarization event
  mapping (row `system`/`compact_boundary` and `PostCompact` hook →
  `summarization`, §2 table + §4.3). This section adds the *mechanics behind*
  that mapping (which hook, why it's the only source, the fold-granularity
  consequence) — it does not re-derive the mapping table itself.
- **File-path pointers:** `../electric/packages/agents-runtime/src/claude/claude-precompaction.ts`
  (pre-run guard, full file, key fns `estimateHistoryTokens` :114-130,
  `maybePrecompactClaudeHistory` :190-248); `../electric/packages/agents-runtime/src/claude/claude-history-policy.ts`
  (defensive filter, full file, `applyHistoryPolicy` :161-184);
  `../electric/packages/agents-runtime/src/claude/claude-adapter.ts:1143-1220ish`
  (PostCompact hook registration — grep `PostCompact` in that file for all 6
  call sites) and `:1293-1299` (wiring into `query()` options); wiring call
  site `../electric/packages/agents-runtime/src/context-factory.ts:956-971`.

### 1.4 `validate-config.ts` / `harness-guard.ts` — the minimum-viable headless config

Two small, SDK-free guard modules, both meant to be imported **statically**
(never pull the optional CASDK dependency in just to validate or gate):

- **`harness-guard.ts`** (29 lines, full file) — `assertClaudeHarnessEnabled()`:
  a pure ops kill-switch. Throws if `ELECTRIC_AGENTS_DISABLE_CLAUDE_HARNESS=1`
  is set, no-ops otherwise. Called **first**, before any lazy SDK import, so
  the guard trips without ever touching the SDK. **Directly reusable pattern
  for teaspill T7.3** (packaging/rollout): a single env-var rollback lever
  that doesn't require a code deploy.
- **`validate-config.ts`** (84 lines, full file) — `validateClaudeHarnessConfig(config)`:
  throws with an actionable message, at config time, for every pi-only field
  the CASDK harness cannot honor. This **is** the enumerated minimum-viable
  headless config, expressed as rejections:
  - `provider` must be absent or `'anthropic'` (CASDK only speaks Anthropic).
  - `model` must be a plain string (no pi `Model` objects).
  - `streamFn`, `onPayload`, `thinkingBudgets`, `summarizeComplete` → hard
    rejected, "not supported by claude-sdk harness."
  - `reasoning` is the one field that **looked** unsupportable but turned out
    mappable: pi's `ThinkingLevel` → SDK `thinking: { type: 'enabled', budgetTokens }`
    via a static table (`REASONING_THINKING_BUDGETS`,
    `claude-adapter.ts:97-102`: `minimal:1024, low:4096, medium:8192, high:16384, xhigh:32768`).
  - Explicitly **supported, no restriction**: `tools`, `systemPrompt`,
    `getApiKey` (anthropic only), `onStepEnd`, `modelTimeoutMs`, `testResponses`.
- **The actual headless-run surface** (assembled from `claude-adapter.ts`'s
  `query()` options, confirmed by `test/claude-adapter-lifecycle.test.ts`):
  `settingSources: []` (no user-config hooks/settings pollute the session —
  called out in the plan as a **critical** flag, its omission was the #1
  contamination risk found in Task 0.3), `permissionMode: 'bypassPermissions'`,
  `tools: []` (the **authoritative** switch that hard-disables *all* built-in
  Claude Code tools — `allowedTools` alone only auto-approves, it does
  **not** disable; omitting `tools` entirely falls back to the `claude_code`
  preset = every built-in enabled, which the spike found was a **live latent
  bug** in its own early adapter draft before Task 4.1 fixed it), `mcpServers`
  = the in-process electric server (separate flag, `--mcp-config`, coexists
  fine with `tools: []` — live-verified in Task 4.2), `allowedTools` = every
  `mcp__electric__<name>` (auto-approve only, not the disable switch),
  `includePartialMessages: true` (required for streaming deltas), no
  subagent support was ever wired (out of scope from the plan's opening
  line; the mapping doc's "subagent traffic → opaque, defensively" is the
  correct posture if one somehow appears), `systemPrompt` passed as a
  **fully custom bare string** (`opts.systemPrompt ?? ''`), which
  **replaces** the Claude Code preset system prompt entirely — confirmed
  intentional and necessary for parity with the pi harness's prompt
  ownership.
- **File-path pointers:** `../electric/packages/agents-runtime/src/claude/validate-config.ts`
  (full file, 84 lines); `../electric/packages/agents-runtime/src/claude/harness-guard.ts`
  (full file, 29 lines); the query-options assembly is in
  `../electric/packages/agents-runtime/src/claude/claude-adapter.ts` around
  the `query({ ... })` call inside `createClaudeAgentAdapter` (:884-1613,
  grep `settingSources`/`permissionMode`/`tools:` for exact lines — they
  move slightly across the ~1613-line file's version).

### 1.5 Usage accounting specifics

`claude-usage.ts` (full file, 223 lines) is a **pure, SDK-free** mapping —
`mapAnthropicUsage(usage, opts)` (:175-222) — deliberately mirrored
field-for-field against the pi harness's own usage plumbing so both harnesses
report tokens identically to consumers. Key rules, all directly reusable for
teaspill's `RunUsage` mapping (already captured at a summary level in
`docs/casdk-mapping.md` §6 — this adds the *why*):

- `tokenInput`/`tokenInputUncached` = `input_tokens + cache_creation_input_tokens`
  — cache **reads** are deliberately excluded because they re-count the whole
  conversation on every warm turn (would balloon a "tokens this step" label
  and burn a goal budget in a couple of steps regardless of new work).
- `tokenContext` = `input + cache_creation + cache_read` (cache-inclusive —
  what a "% of context used" gauge needs, since cached tokens still occupy
  the window).
- **Missing fields stay `undefined`, never coerced to 0** — so a step with no
  reported usage omits the column rather than writing a fabricated zero
  indistinguishable from a genuine zero-token step. (`onStepEndStats`, by
  contrast, *does* default to 0 — different contract, the goal-budget
  enforcement path expects plain numbers.)
- **Context window is a static lookup**, not SDK-reported: the pinned SDK's
  `system`/`init` message carries no context-window field; only the
  *terminal* `result.modelUsage` might, arriving too late to annotate
  already-closed step rows. `CONTEXT_WINDOWS` (:130-141) is a small
  prefix-matched table (all current Claude families = 1M except Haiku
  4.5 = 200K); unknown model ids resolve to `undefined` (field omitted, not
  guessed).
- **Per-step vs cumulative usage — the double-count hazard:** per-step usage
  is accumulated from `message_start`/`message_delta` and mapped at
  `message_stop`; the terminal `result` message's cumulative usage is
  **never** routed through this mapper (the adapter deliberately skips it) —
  routing it would double-count as an extra phantom step. Already reflected
  in `docs/casdk-mapping.md`'s row for `stream_event message_start/message_delta/message_stop`
  ("Cumulative `result` usage is never routed per-step").
- **File-path pointer:** `../electric/packages/agents-runtime/src/claude/claude-usage.ts`
  — `sumPresentNumbers` (:101-111, the undefined-preserving summer),
  `resolveContextWindow` (:149-160), `mapAnthropicUsage` (:175-222).

## 2. Translation logic + WHERE it lives, organized by D5 layer

`docs/casdk-mapping.md` owns the *event-shape* translation table (§2/§3 of
that doc). This section maps the spike's *modules* onto D5's three durability
layers so T7.1/T7.2 know which file backs which layer.

### Effects (idempotent tool execution)
- `../electric/packages/agents-runtime/src/claude/claude-tools.ts` (309 lines,
  full file) — `buildElectricMcpServer(tools, sdk)` (:165-191) builds one
  in-process MCP server (`ELECTRIC_MCP_SERVER = 'electric'`, :40) exposing
  every tool as `mcp__electric__<name>`. `toMcpName`/`fromMcpName` (:49-63)
  are the single source of truth for that qualification — teaspill's T7.2
  will want the equivalent for `mcp__teaspill__<name>` (already assumed by
  `docs/casdk-mapping.md` §3's session-line table).
  **Schema conversion gotcha, not yet documented elsewhere:** the SDK's
  `tool()` requires a **Zod schema or raw shape** — passing a raw JSON Schema
  object throws at runtime (`"inputSchema must be a Zod schema or raw shape"`).
  Electric's tools carry TypeBox parameters (which *are* JSON Schema), so the
  spike bridges with `z.fromJSONSchema(parameters).shape` (:212-238,
  `toZodRawShape`, non-throwing — a conversion failure degrades to an empty
  parameter shape + a warning rather than breaking the whole server build).
  **Teaspill's T3.3 platform tools use Zod schemas already** (per PLAN.md
  T3.3: "Zod schemas + docstrings"), so this conversion step is likely
  unnecessary for teaspill — but it's the exact failure mode to watch for if
  any tool schema arrives as raw JSON Schema instead.
  Execute wrapper (:246-264, `runElectricTool`) is where the idempotency-key
  contract (T3.1's `(entityUrl, runId, toolUseId)`) must be threaded through
  for teaspill — the spike's wrapper only has a **best-effort** tool-call id
  (`readToolCallId`, :292-299 — falls back to the MCP JSON-RPC `requestId`
  because the Anthropic `tool_use` block id is **not exposed to the MCP
  handler**). This is an important gap: teaspill's exactly-once idempotency
  key needs the real `toolUseId`, and the spike's mechanism for getting it
  (matching it up on the *stream* side, in `claude-adapter.ts`'s tool_use →
  tool_result mapping, not inside the MCP handler itself) is the pattern to
  copy — do not expect the MCP handler's `extra` to carry it reliably.
- Throwing tools become `isError: true` MCP results, never crash the server
  (:258-263) — matches teaspill's tool-contract expectations already.

### Continuation (the intra-run journal / warm-resume mechanism)
- `../electric/packages/agents-runtime/src/claude/claude-session-store.ts` —
  see §1.1. **This is the layer where the spike provides the least prior
  art** — see §6, the flagged gap.
- `../electric/packages/agents-runtime/src/claude/claude-repair.ts` — see
  §1.2. Directly reusable: crash-mid-tool repair is needed regardless of
  whether teaspill's warm path or cold path is active (a warm-resumed session
  can *also* have a dangling tool call if the crash happened between the
  tool call and its result on the SDK's own side).
- `../electric/packages/agents-runtime/src/claude/claude-adapter.ts` — the
  per-run lifecycle (`createClaudeAgentAdapter`, :884-1613): workspace
  creation, `mkdtemp` cwd, calling `query()`, draining the iterator, cleanup.
  This is what T7.1's `ctx.run` wrapper will structurally resemble, **but the
  spike's lifecycle is "one full lifecycle per wake, throwaway after,"** not
  "resume mid-lifecycle after a retry" — see §6.

### Truth (canonical timeline authority, trust-but-verify)
- `../electric/packages/agents-runtime/src/claude/claude-adapter.ts` —
  `createSdkStreamMapper` (:396-880ish, the "capture" state machine, fully
  described by `docs/casdk-mapping.md` §2 — not re-described here). The
  **resume-mismatch hard check** (grep `claude_session_resume_mismatch` — 6
  call sites, e.g. :795-810, :1089, :1376, :1433) is directly relevant to
  D5 layer 3's "trust but verify": the spike's version of "verify" is
  comparing the `system`/`init` message's `session_id` against the
  `sessionId` it asked to resume — if they differ, the SDK silently started
  a fresh session (the #1 operational trap called out throughout the plan)
  and the adapter now treats that as a **hard `ModelProviderError`**, not a
  silent continue. **Teaspill's seq-stamp check is a stronger, purpose-built
  version of the same idea** (compare canonical seq, not just session
  identity) — this confirms the general pattern (detect silent
  divergence, fail loud) is sound and was worth hardening in the spike too.
- `../electric/packages/agents-runtime/src/claude/claude-precompaction.ts` +
  the `PostCompact` hook in `claude-adapter.ts` — see §1.3. Both are
  "Truth"-layer concerns: they're the mechanisms by which CASDK-side context
  compression gets folded back into the durable record instead of being
  silently lost.

## 3. Edge cases discovered

Cross-referenced against `docs/casdk-mapping.md` where it already covers the
same ground; only genuinely new items are called out as new.

- **Already covered by `docs/casdk-mapping.md`:** thinking-signature
  stripping (§4.5); compaction-mid-run fold granularity (§2, `PostCompact`
  row — this digest's §1.3 adds *why* only that hook carries summary text);
  ID mapping via MCP-qualified names (§3); dangling `tool_call` repair (§3,
  last row — this digest's §1.2 adds the exact algorithm and the pi-harness
  gap it flagged); usage double-counting (§2, `message_start`/`message_delta`/`message_stop`
  row and §6).
- **New — silent fresh-session-on-resume** (not about the schema, about
  *detecting divergence*): a cwd/projectKey mismatch, an env/config-dir
  isolation failure, or a malformed synthesized entry can all make the SDK
  silently start a brand-new session instead of resuming — with **no error**,
  just an unexpected `session_id` in the `system`/`init` message and prior
  history invisible to the model. The spike's runtime defense
  (`claude_session_resume_mismatch`, §2 "Truth" above) is new knowledge not
  in the mapping doc; T7.1's seq-stamp check should treat "session_id ≠
  expected" as one trigger for cold rebuild, in addition to seq mismatch.
- **New — SessionStore is `@alpha` and dual-writes regardless of what our
  store does.** Even when `append()` is a no-op (as in the spike), the CASDK
  subprocess still writes its **own** local JSONL mirror (`persistSession`
  cannot be disabled). This has no functional impact on the spike (it never
  reads that local mirror back) but is worth knowing operationally: a
  container running the CASDK CLI subprocess will accumulate local session
  files unless something cleans the temp workspace — the spike's adapter
  does this via `finally: rm -rf` on its per-run tmp dir (:`claude-adapter.ts`
  lifecycle, confirmed by `test/claude-adapter-lifecycle.test.ts`'s "creates
  the tmp cwd during the run and removes it after" test). T7.3 (packaging)
  should carry this cleanup-on-exit discipline forward.
- **New — the MCP tool handler does not reliably receive the real
  `toolUseId`.** Called out in §2 "Effects" above; worth restating as an
  edge case because it is easy to assume the MCP `extra.requestId` is the
  Anthropic `tool_use` block id (they are not guaranteed to correlate) — the
  reliable place to read the real id is the stream mapper's own `tool_use`
  block parsing, not inside the tool execution handler.
- **New — concurrency/filesystem hygiene, verified not by inspection but by a
  live-shaped test:** two claude-harness runs held concurrently (via gated
  mocks) in one process do not cross-talk — distinct `mkdtemp` cwd, distinct
  env, distinct resume ids, no shared mutable state (`test/claude-concurrency-hygiene.test.ts`,
  9 tests). No mutex is needed because the SDK's `options.env` genuinely
  isolates per-`query()`-call state (contradicts what the plan's Task 3.1
  anticipated as a possible failure mode requiring a module-level mutex —
  that fallback was never needed). Relevant to teaspill's agent-loop services
  being stateless replicas handling many concurrent CASDK runs (D4) — the
  isolation primitive the spike relied on (`options.env` per call) is exactly
  what teaspill's agent-loop replicas will also depend on.

## 4. Completed vs abandoned (knowledge about the spike's coverage, not tasks)

Everything through **Phase 6 Task 6.1** (SDK-compaction persistence via the
`PostCompact` hook) is implemented and tested, confirmed by source
inspection, not just the plan's own checkmark annotations:

- Phases 0-5 (spikes/format capture, config surface, session synthesis,
  the adapter itself, tool bridge, runtime integration/parity) — all present,
  all tested (test files for every phase exist under
  `../electric/packages/agents-runtime/test/claude-*.test.ts`, 21 files).
- **Task 6.1** (SDK-compaction → electric checkpoint via `PostCompact` hook) —
  implemented and wired (`claude-adapter.ts` hook registration +
  `context-factory.ts` sink), despite the plan file's header for 6.1 lacking
  an explicit checkmark annotation like other tasks — verified by reading the
  actual source and its wiring, not by trusting the plan's own status marks.
  **This is itself a small lesson:** the plan's checkmarks are not fully
  reliable evidence of completion state; source + tests are.
- **Task 6.2** (pre-run precompaction guard) — also implemented and wired
  live (`context-factory.ts:956-971` calls `maybePrecompactClaudeHistory`),
  again without an explicit plan-header checkmark.
- **Task 7.1** (error taxonomy) — **partially done**: all four error codes
  (`claude_cli_not_found`, `claude_session_resume_mismatch`,
  `claude_sdk_inactivity_timeout`, `claude_sdk_process_exit`) exist in
  `model-provider-error.ts` and are used at their call sites in
  `claude-adapter.ts`. `runtimeLog` line parity with the pi adapter appears
  present by inspection (same `agent.run starting provider=... harness=...`
  style) but was not exhaustively diffed line-for-line.
- **Task 7.2 (docs), 7.3 (CI wiring), 7.4 (manual smoke script) — appear
  NOT done.** No `src/claude/README.md` exists (only a short "Claude harness
  (experimental)" section in the package's top-level README). No
  `scratch/claude-spike/` directory exists in the working tree (expected —
  it was gitignored scratch space per the plan, and the spike's uncommitted
  changes don't include gitignored paths). No smoke-script file was found
  under any `examples/`/`scratch/` path. **This is knowledge about SDK/spike
  coverage, not a teaspill task** — it just means T7.1/T7.2 should not expect
  a docs writeup or CI-gating pattern to lift from the spike for those two
  areas; the error-taxonomy pattern (§ above) and the offline/live test-gating
  pattern (`describe.skipIf(!ANTHROPIC_API_KEY && !CLAUDE_CODE_OAUTH_TOKEN && !CLAUDE_HARNESS_LIVE)`,
  used throughout `test/claude-*roundtrip*.test.ts` and `test/claude-*e2e*.test.ts`)
  **are** worth lifting.
- **`steer()` was deliberately left unimplemented, by a reasoned decision, not
  an oversight:** the spike's `handle.steer()` throws
  `"steer not supported by claude-sdk harness yet"` (`claude-adapter.ts:1578`).
  The decision record (`CLAUDE_AGENT_SDK_PLAN.md` Task 3.5 annotation) found,
  by grepping the whole electric codebase, that `handle.steer()` had **zero
  callers** — electric's own `mode: 'steer'` inbox flag is a wake-*scheduling*
  signal that becomes an ordinary next-wake user message, never a live
  mid-run injection. It also found that implementing real steering requires
  switching the whole run to **streaming-input mode** (`prompt: AsyncIterable<SDKUserMessage>`),
  which changes run *termination* semantics (the queue must be explicitly
  closed) and was never validated against the resume contract that Task 0.4
  spent the most effort proving out. **Directly relevant to teaspill's T7.2**
  (which *does* need steering, via D5/D8's steerbox): the streaming-input
  requirement is confirmed real and necessary (not avoidable), but its
  interaction with `resume`/`sessionStore` is **unvalidated** by the spike —
  this is new uncertainty for T7.2 to budget for explicitly, not something
  it can treat as de-risked.

## 5. Interrupt mapping (`abort()`)

Not previously covered by the mapping doc. The spike's `abort()` is a plain
`AbortController` passed as `options.abortController` to `query()`
(confirmed live in `test/claude-adapter-lifecycle.test.ts`'s "abort()
propagates to the SDK abortController and ends the run as aborted" test — an
in-flight run's `finish_reason` becomes `aborted`, one clean `run` `update`
event, `isRunning()` returns to `false`). This is a **direct, simple match**
for D5/A8's `interrupt` verb → SDK interrupt mapping — no gap found here. One
detail worth carrying forward: the spike's abort is idempotent and safe
post-settle (calling `abort()` after the run already finished is a documented
no-op, never throws) — `dispose()` reuses the exact same path.

## 6. Contradictions with D5 — flag loudly, HALT candidate for T7.1

**The spike never implements or validates D5's "warm path" at all.** This is
not a contradiction of D5's *design* — it's a gap in what the spike de-risks,
and the gap is large enough that T7.1 should treat it as its own
highest-uncertainty sub-problem (comparable to the spike's own Task 0.4, its
single "L" / highest-uncertainty task), not as something inherited "mostly
solved" from the spike.

**What D5 (Continuation layer) assumes:** "the CASDK durable session
(SessionStore / session files on persistent storage keyed by entity) is the
intra-run journal — the same mechanism Claude Code's own interrupt-and-continue
uses. A retried `ctx.run` resumes the session and continues from the last
persisted step instead of restarting the run."

**What the spike actually built:** every single wake calls `buildSessionInput`,
which mints a **brand-new random `sessionId`** (`claude-session-store.ts:175`,
`randomUUID()` — not the same id as any prior wake) and synthesizes the
*entire* history fresh from Electric's canonical stream (via
`repairDanglingToolCalls` → `applyHistoryPolicy` → `toAnthropicMessages`).
`ElectricSessionStore.append()` is an intentional no-op (§1.1). There is
**no code path in the spike where a second `query()` call resumes the literal
same session a prior call used** — "resume" in the spike's vocabulary means
"prime a fresh session with reconstructed history," which is precisely
teaspill's D5 **cold path**, done unconditionally, every wake. The spike is
architected this way *on purpose* — electric's own design principle (stated
at the top of `CLAUDE_AGENT_SDK_PLAN.md`) is "the Electric entity stream is
the single source of truth... the [session] file is a derived, throwaway
cache." That is a deliberate, reasoned choice for electric's architecture,
and it happens to be exactly the class of design PLAN.md §1 says teaspill is
moving *away from* by trusting a genuinely durable intra-run journal instead
of always reprojecting.

**Consequence for T7.1:** the mechanical facts recorded in §1.1 (how
`load()`/`append()` are called, what they receive, keying rules) are real and
reusable, but the actual **persistence-across-retries** behavior — does a
`SessionStore` whose `append()` really writes to durable storage and whose
`load()` really reads it back reconstruct a mid-run CASDK session correctly
after a crash, *without* our own reprojection? — was **never exercised**.
Concretely unresolved questions T7.1 must answer itself, with no spike
prior art:
1. Does `append()`'s "new turn lines only, batched" delivery contain enough
   information to reconstruct exact mid-run state (e.g., a tool call issued
   but not yet resulted, mid-stream) if a `ctx.run` retry calls `query()`
   again with the *same* `resume` id and a *real*, non-no-op `load()`?
2. Given `SessionStore` is `@alpha`, does its contract (call timing,
   batching shape) hold across a genuine process crash-and-restart, or only
   across the graceful within-process resume the spike tested?
3. Where does the seq-stamp comparison happen relative to `load()` being
   called exactly once, pre-spawn — before the adapter has any chance to
   decide "warm vs cold" from inside the store itself? (The spike's
   `load()` has no seq-awareness at all — it always returns the same
   thing regardless of what's asked.)

**Recommendation:** T7.1 should budget explicit spike/experiment time
(mirroring the source plan's own Task 0.4 shape: minimal script, live SDK,
binary-search what's required) to validate real `append()`/`load()`
persistence and mid-run resume **before** committing to the warm-path design
in D5's Continuation layer as-written. If persistence-across-retries proves
unreliable or the `@alpha` API changes shape, the fallback is not
catastrophic — it degrades to "every `ctx.run` retry is a cold rebuild,"
which is exactly the spike's own (working, well-tested) architecture, just
without the efficiency win D5 wants from the warm path. That fallback should
be named explicitly in T7.1's design rather than discovered under deadline
pressure.

**Secondary, minor note (not a contradiction, a clarification):** D5's CASDK
surface bullet says "hooks used as observers only (PostToolUse + partial-message
events feed finalized events and token deltas to the stream live)." The spike
never registers a `PostToolUse` hook at all — tool call/result events are
captured entirely from the message stream itself (`tool_use`/`tool_result`
content blocks), which already carries everything needed. The **only** hook
the spike found necessary is `PostCompact`, and only because that is the
sole place the SDK exposes compaction summary text (§1.3). T7.2 should not
assume it needs to wire a `PostToolUse` hook for finalized tool events — the
stream alone appears sufficient, per this spike's experience — but should
budget for `PostCompact` if teaspill wants SDK-compaction interop at all
(optional; teaspill could instead rely purely on its own `summarization`
event framing and ignore CASDK's internal compaction entirely, letting cold
rebuild always win, which is arguably simpler and consistent with D5 layer
3's "canonical wins on cold rebuild" stance already).

## 7. If `../electric` were absent

Not applicable — confirmed present (see header). For future reference: the
fallback is `docs/casdk-mapping.md` alone, which covers the event-mapping
table but not session-store/repair/precompaction/min-config mechanics in
this digest.
