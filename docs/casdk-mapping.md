# CASDK ↔ canonical event paper-mapping (T7.1 sketch — the T0.1 freeze-gate artifact)

**Schema status: PROPOSED, not frozen.** This document is what the main
session reviews at gate G3 (PLAN §6 gate 1) to freeze the T0.1 schema. It
maps every record type the Claude Agent SDK emits — on its live message
stream and in its durable-session line format — onto a canonical event type
(or `opaque`), demonstrates the round-trip is lossless, lists every CASDK
shape with **no clean canonical home** and how `opaque` carries it, and ends
with a short pi-ai → canonical sketch.

**Sources** (the `../electric` CASDK spike, uncommitted working tree; SDK
pinned `@anthropic-ai/claude-agent-sdk@0.3.211`, bundled CLI `2.1.211`):

- `../electric/packages/agents-runtime/src/claude/SESSION_FORMAT.md` — the
  live-verified minimum session-line contract (what a synthesized resume needs).
- `../electric/packages/agents-runtime/src/claude/claude-adapter.ts` — the
  SDK-stream → bridge state machine (the complete list of stream record types
  and their dedup/ordering hazards).
- `../electric/packages/agents-runtime/src/claude/claude-messages.ts` — the
  history → Anthropic `MessageParam[]` converter (merge semantics).
- `../electric/packages/agents-runtime/src/claude/claude-usage.ts` — usage
  field semantics shared by both harnesses.
- `../electric/packages/agents-runtime/src/pi-adapter.ts` — pi-ai integration
  shape (§6).

Canonical schema under review: `packages/schema/src/events.ts` (+
`deltas.ts`); harness seam: `packages/harness-native/src/interface.ts` (+
`context.ts`).

---

## 1. The two CASDK surfaces, and which direction each maps

The CASDK harness (D5) touches the SDK in two places:

1. **Capture (live), SDK → canonical.** During a run, `query()` yields an
   interleaved stream of `SDKMessage`s (raw API deltas + full messages +
   lifecycle records). The harness translates finalized content into
   `TimelineEventInit`s (committed via the outbox) and partial content into
   `DeltaRecord`s (fire-and-forget onto the sibling `/deltas` stream). §2.
2. **Cold rebuild, canonical → session lines.** When the durable session is
   lost or its seq stamp mismatches canonical head (D5 layer 3), the harness
   re-synthesizes a session JSONL from canonical events and resumes it. §3.
   The warm path never projects — the durable session itself is the
   continuation state, so **projection fidelity is a recovery concern, not an
   every-wake concern** (this is what makes R3 churn survivable).

Round-trip requirement (R2/R3): capture followed by cold rebuild must
reproduce a session the SDK resumes with identical conversational content
(golden fixture in T7.1: cold-projection → resume(no-op) → capture →
canonical must be identity-modulo-ids).

## 2. Live stream → canonical (capture direction)

`SDKMessage` types observed in the pinned SDK (from `claude-adapter.ts`'s
exhaustive `handleMessage`/`handleStreamEvent` switches):

| CASDK stream record                                                 | Canonical destination                                                                                                                                              | Lossless-ness notes                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`/`init`                                                     | absorbed into **`run_started`** (`harness: 'casdk'`, `model`, `detail: { sessionId, … }`)                                                                          | `run_started` is authored by the harness driver; init contributes fields. `session_id` also feeds the resume-mismatch check and the `stateDelta.harness` seq-stamp (D5 layer 3). Extra init fields (tools list, cwd, permissionMode) are **config, not history** — regenerable, kept in `detail` for observability only.                 |
| `stream_event` `message_start` / `message_delta` / `message_stop`   | no canonical event — step bookkeeping + per-step usage accumulation (rolls up into `run_finished.payload.usage`); optional **`usage` DeltaRecord** for live gauges | Cumulative `result` usage is never routed per-step (double-count hazard, see claude-usage.ts).                                                                                                                                                                                                                                           |
| `stream_event` `content_block_delta` `text_delta`                   | **`text` DeltaRecord** (`ref` = the eventual `message.payload.id`)                                                                                                 | Ephemeral by design; finalized event wins (T5.2 dedup rule).                                                                                                                                                                                                                                                                             |
| `stream_event` `content_block_delta` `thinking_delta`               | **`reasoning` DeltaRecord** (`ref` = the eventual `reasoning.payload.id`)                                                                                          | Same.                                                                                                                                                                                                                                                                                                                                    |
| `stream_event` `content_block_delta` `input_json_delta`             | **`tool_input` DeltaRecord** (`ref` = toolUseId)                                                                                                                   | Parsed input arrives authoritative on the full assistant message.                                                                                                                                                                                                                                                                        |
| `stream_event` `content_block_delta` `signature_delta`              | **deliberately dropped**                                                                                                                                           | Thinking signatures are never persisted (unforgeable, session-bound — §4.5).                                                                                                                                                                                                                                                             |
| full `assistant` message, `text` block                              | **`message`** (`role: 'assistant'`)                                                                                                                                | Double-render guard: deltas preferred live; the finalized event is the single canonical record either way.                                                                                                                                                                                                                               |
| full `assistant` message, `thinking` block                          | **`reasoning`** (`text`)                                                                                                                                           | Display-only history — never re-enters provider context (§4.5).                                                                                                                                                                                                                                                                          |
| full `assistant` message, `redacted_thinking` block                 | **`reasoning`** (`encrypted`)                                                                                                                                      | Payload round-trips as an opaque string.                                                                                                                                                                                                                                                                                                 |
| full `assistant` message, `tool_use` block                          | **`tool_call`** (`toolUseId` = block id, `name` de-MCP-qualified, `input`)                                                                                         | `toolUseId` is the third component of the exactly-once idempotency key `(entityUrl, runId, toolUseId)` (T3.1).                                                                                                                                                                                                                           |
| full `user` message, `tool_result` block                            | **`tool_result`** (`content`, `isError`)                                                                                                                           | Known limitation inherited from the SDK: the MCP boundary carries only `content` blocks back — a tool's structured `detail` is dropped in the subprocess. Canonical `detail` stays optional; the CASDK harness can back-fill it from its OWN tool execution (we run the tools in-process), which is better than electric managed (§4.6). |
| full `user` message, plain text                                     | **not captured**                                                                                                                                                   | It is the SDK replaying our own prompt — the wake `message` event already exists on the timeline. Capturing it again would duplicate.                                                                                                                                                                                                    |
| `system`/`compact_boundary`                                         | contributes `detail` (= `compact_metadata`: trigger, pre_tokens) to **`summarization`**                                                                            | Boundary record is metadata-only — carries NO summary text (verified in sdk.d.ts 0.3.211).                                                                                                                                                                                                                                               |
| `PostCompact` hook `compact_summary`                                | **`summarization`** (`summary`, `replacesThroughSeq` = canonical seq of the last context-bearing event folded)                                                     | The ONLY place the SDK exposes the summary text. Canonical `summarization` wins on any later cold rebuild — the SDK's own compaction never rewrites canonical truth (D5 layer 3).                                                                                                                                                        |
| `result` `success`                                                  | **`run_finished`** (`outcome: 'success'`, `usage` w/ `attempt`)                                                                                                    | Usage `attempt` = Restate invocation attempt; consumers keep latest attempt only (T7.4 retry rule).                                                                                                                                                                                                                                      |
| `result` `error_*` (`error_during_execution`, `error_max_turns`, …) | **`error`** (`source: 'harness'`, `code`) + **`run_finished`** (`outcome: 'error'`)                                                                                | Subprocess spawn/exit failures caught outside the stream map the same way.                                                                                                                                                                                                                                                               |
| status / notification / task chatter, rate-limit events             | **known-and-dropped** (documented operational chatter)                                                                                                             | See §4.4 — the R3 rule is: _known_ chatter is deliberately dropped; _unknown_ record types are NEVER dropped, they become `opaque`.                                                                                                                                                                                                      |
| any UNKNOWN / future `SDKMessage` type                              | **`opaque`** (`origin: 'casdk'`, `kind: 'stream/<type>[/<subtype>]'`, `data` = record verbatim)                                                                    | The lock-in/churn valve. A pinned-SDK bump that adds record types costs a mapping-table update, never data.                                                                                                                                                                                                                              |
| subagent traffic (`parent_tool_use_id !== null`)                    | must not occur (no built-in subagents, D5); defensively → `opaque`                                                                                                 | Config forbids subagents; opaque capture makes a misconfiguration visible instead of silent.                                                                                                                                                                                                                                             |

## 3. Canonical → session lines (cold-rebuild direction)

Target contract: SESSION_FORMAT.md's verified minimum — per line
`{ type, message, timestamp, uuid, parentUuid }`, four line shapes, one
content block per assistant line, `tool_use`/`tool_result` ids paired,
MCP-qualified tool names, first message must be `user`.

| Canonical event                                                                                                                                        | Session line(s) produced                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message` (`user`)                                                                                                                                     | user line                                                                                                                                                                                                                                                                                                                                    |
| `message` (`assistant`)                                                                                                                                | assistant text line(s) — one content block per line                                                                                                                                                                                                                                                                                          |
| `message` (`system_note`)                                                                                                                              | user line with an explicit marker (`[system note] …`) — never the API system prompt (that is harness config)                                                                                                                                                                                                                                 |
| `tool_call`                                                                                                                                            | assistant `tool_use` line (`name` MCP-qualified `mcp__teaspill__<name>`, id = `toolUseId`)                                                                                                                                                                                                                                                   |
| `tool_result`                                                                                                                                          | user `tool_result` line (`is_error` set only when true, matching the observed on-disk format)                                                                                                                                                                                                                                                |
| `summarization`                                                                                                                                        | ONE user line rendering `summary` as a context note, standing in for everything `<= replacesThroughSeq` (electric's compaction-checkpoint fold pattern)                                                                                                                                                                                      |
| `reasoning`                                                                                                                                            | **stripped — no line.** See §4.5.                                                                                                                                                                                                                                                                                                            |
| `opaque` (`origin: 'casdk'`, `kind: 'session/*'`)                                                                                                      | replayed verbatim as its original line                                                                                                                                                                                                                                                                                                       |
| `entity_spawned`, `run_started`, `run_finished`, `control`, `error`, `child_spawned`, `child_finished`, `state_snapshot`, `archived`, foreign `opaque` | no session line. Where the model must know about one (a child finished, an interrupt happened), the platform expresses it as an explicit `message(system_note)` — which projects per row 3. This keeps the projection rule trivial: _only context-bearing events project_ (`selectContextEvents`, `packages/harness-native/src/context.ts`). |
| dangling `tool_call` without `tool_result` (crash mid-tool)                                                                                            | repaired before projection: synthesize an error `tool_result` line (electric's `repairDanglingToolCalls` pattern; ORDERING DEPENDENCY noted in claude-messages.ts)                                                                                                                                                                           |

Line mechanics: `uuid`/`parentUuid` are synthesized fresh per rebuild
(SESSION_FORMAT: presence matters, values are regenerable; chain correctness
costs nothing so we emit it); `timestamp` = the event's `ts` (schema
guarantees parseable ISO — the ONE hard session-format requirement);
`sessionId`/`cwd`/meta lines are omitted (verified droppable).

## 4. CASDK shapes with NO clean canonical home (and the `opaque` story)

1. **Session meta lines** — `queue-operation`, `file-history-snapshot`,
   `ai-title`, `last-prompt`, `mode`. Verified unnecessary for resume
   (SESSION_FORMAT experiment matrix). Not synthesized on rebuild. If a
   capture path ever reads session files directly and meets them, they ride
   as `opaque(kind: 'session/<type>')` rather than being dropped.
2. **`system`/`init` extras** (tools list, cwd, permissionMode, slash
   commands, …) — configuration echo, not history. Absorbed into
   `run_started.payload.detail`; regenerated from harness config on any
   rebuild. Nothing to round-trip.
3. **`compact_boundary.compact_metadata`** — had no home until this mapping;
   resolved by adding optional `summarization.payload.detail` (schema change
   made during T0.1, flagged for freeze review).
4. **Status/notification/task/rate-limit stream chatter** — deliberately
   dropped, enumerated here as the known-drop list. The R3 discipline: this
   list is exhaustive per pinned SDK version; anything not on it and not in
   §2's table goes to `opaque`. A CI golden-fixture diff on SDK bump keeps
   the list honest.
5. **Thinking signatures** (`signature_delta`, and the signature on stored
   `thinking` blocks) — the one _deliberate_ asymmetry. Signatures are
   unforgeable, model-turn-bound (~444 chars), and MUST NOT be replayed into
   a synthesized session (electric Task 2.3 finding; a forged signature is
   the one thing that could poison a resume). Canonical `reasoning` is
   therefore display-only: captured for UIs, stripped on cold rebuild. The
   warm path loses nothing — the SDK's own session retains its real thinking
   blocks. `opaque` is deliberately NOT used here: carrying signatures would
   recreate the hazard.
6. **`tool_result` rich detail through MCP** — the SDK's MCP boundary
   returns only `content` blocks; electric's `AgentToolResult.details` was
   unrecoverable from the stream. Teaspill executes every tool in-process
   (T7.2 serves them to the SDK), so the harness can write
   `tool_result.payload.detail` from the tool's OWN return value instead of
   the echo the SDK streams back — recovering what electric lost. Mapping
   consequence: canonical `detail` is populated by the tool layer, not the
   stream mapper.
7. **Cumulative `result` usage vs per-step usage** — the terminal `result`
   carries cumulative/modelUsage numbers; per-step usage lives on
   `message_start`/`message_delta`. Canonical stores the authoritative run
   total on `run_finished.payload.usage` (with `attempt` for retry
   reconciliation); per-step figures are delta-stream material only. No
   canonical per-step usage event — deliberate (step framing is
   harness-internal).

## 5. Why the round-trip is lossless (the freeze argument)

- **Warm path (every normal wake):** nothing is projected; the durable
  session is the continuation state and canonical is the audit truth. Losses
  are impossible by construction.
- **Cold path:** the resume contract (SESSION_FORMAT min5) needs exactly
  four line shapes + valid timestamps + paired tool ids. Every one of those
  is derivable from `message`/`tool_call`/`tool_result`/`summarization`
  events (§3); ids are regenerable; the only intentionally-non-round-tripped
  content is thinking signatures (§4.5, a security feature) and known
  operational chatter (§4.4, enumerated).
- **Unknowns:** any record the mapper does not recognize — future SDK
  types, new session line types — becomes `opaque` with origin+kind tags and
  verbatim JSON `data` (schema test: parse → serialize → parse is
  deep-equal). `opaque(origin:'casdk')` replays verbatim on rebuild; all
  other consumers skip it. R2 (lock-in) and R3 (churn) both reduce to
  "update the mapping table," never "lose data."
- **Enforcement:** T7.1 proper adds golden fixtures per pinned SDK version:
  cold-projection → resume(no-op) → capture → canonical must be
  identity-modulo-ids.

## 6. Usage field mapping (shared by both harnesses)

Per `claude-usage.ts` (mirrors pi field-for-field):

| Canonical `RunUsage`     | Anthropic/CASDK                                        | pi-ai                |
| ------------------------ | ------------------------------------------------------ | -------------------- |
| `inputTokens` (uncached) | `input_tokens + cache_creation_input_tokens`           | `input + cacheWrite` |
| `cacheReadTokens`        | `cache_read_input_tokens`                              | `cacheRead`          |
| `outputTokens`           | `output_tokens`                                        | `output`             |
| `contextTokens`          | `input + cache_creation + cache_read` (last step)      | same formula         |
| `attempt`                | Restate invocation attempt (T7.4: latest attempt wins) | same                 |

## 7. pi-ai → canonical sketch (the other harness, T3.2 readiness)

From `pi-adapter.ts` (pi-agent-core `AgentEvent` stream → electric's bridge —
teaspill maps the same callbacks to canonical):

| pi-ai surface                                             | Canonical                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| run start / end (driver-owned)                            | `run_started` / `run_finished`                                                                                                                                           |
| step start / end (`onStepStart`/`onStepEnd` + usage)      | no canonical event; usage accumulates into `run_finished.usage`; optional `usage` delta                                                                                  |
| text start / delta / end                                  | `text` DeltaRecords + one finalized `message(assistant)`                                                                                                                 |
| reasoning start / delta / end (incl. `encrypted`)         | `reasoning` DeltaRecords + one finalized `reasoning`                                                                                                                     |
| tool call start / end                                     | `tool_call` / `tool_result` (toolUseId from pi's tool-call id)                                                                                                           |
| context-budget truncation (T3.2 summarizer)               | `summarization` (summary via a `ctx.run` LLM call)                                                                                                                       |
| provider error (retryable exhausted / terminal)           | `error(source:'provider')` + `run_finished(outcome:'error')`                                                                                                             |
| `LLMMessage` roles `user/assistant/tool_call/tool_result` | 1:1 with `message`/`tool_call`/`tool_result`; `toAgentHistory`'s merge semantics are reproduced by the shared assembly rules in `packages/harness-native/src/context.ts` |

pi-ai has no session file — context is assembled fresh from canonical every
wake (`selectContextEvents` → pi `AgentMessage[]`), so the pi mapping has no
cold/warm split and no opaque needs beyond provider-specific artifacts (e.g.
encrypted reasoning payloads, which `reasoning.encrypted` carries).

## 8. Open points for the freeze review (G3)

1. **`signal` → `control` rename.** PLAN T0.1's vocabulary lists `signal`;
   the schema names it `control` per D8's dropped-POSIX decision (task
   sanctioned "signal/control — pick one"). Confirm.
2. **`summarization.payload.detail` added** during this mapping (§4.3).
3. **`ContentBlock` is text+image only.** CASDK/Anthropic `document` blocks
   or other future user-content kinds would fail validation → they must ride
   `opaque` until the schema grows a block type (attachments are declared out
   of scope v1). Acceptable for freeze?
4. **`tool_result.detail` population responsibility** sits with the tool
   layer, not stream capture (§4.6) — worth stating in T7.2's task notes.
5. **Deltas on the sibling `/deltas` stream** (framing decision in
   `packages/schema/src/deltas.ts`): interacts with T5.1 retention and T1.4
   JWT path-prefix claims (a browser needs both `/timeline` and `/deltas`
   under one prefix — the shared entity prefix satisfies this). No addressing
   change needed (path already reserved).
