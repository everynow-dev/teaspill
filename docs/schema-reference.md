# Canonical event schema reference (v1)

The canonical timeline event is the single vocabulary everything in teaspill
speaks: both harnesses emit it, the projection outbox appends it to the
per-entity timeline stream, the frontend SDK materializes it, and snapshots
and archives are expressed in it. It is defined in
[`packages/schema/src/events.ts`](../packages/schema/src/events.ts) and the
sibling token-delta framing in
[`packages/schema/src/deltas.ts`](../packages/schema/src/deltas.ts).

**Status: FROZEN (v1)** — Gate 1 passed at G3 (2026-07-17, DECISIONS A5).
From here, breaking envelope/payload changes bump `v` and add a migration;
changes are **additive-only within v1**.

See also [addressing.md](./addressing.md) (entity URLs / stream paths) and
[streams.md](./streams.md) (stream layout, snapshot cadence, retention).

---

## Envelope

Every timeline event is `{ v, entityId, seq, ts, type, payload }`:

| Field      | Type                    | Meaning                                                                                                                                             |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`        | `1` (literal)           | Schema version. Bumps only on a breaking change after the freeze.                                                                                  |
| `entityId` | string                  | Canonical entity URL (`/t/<tenant>/a/<type>/<id>`, addressing §2). Identical to `entities.url` and to the durable-streams `Producer-Id` of the entity's outbox. |
| `seq`      | int ≥ 0                 | **0-based, gapless, monotonic per entity** (DECISIONS A1). The ordering authority.                                                                 |
| `ts`       | ISO 8601 (with offset)  | Informational timestamp. Ordering authority is `seq`, not `ts`.                                                                                    |
| `type`     | one of 15 (below)       | Discriminant.                                                                                                                                      |
| `payload`  | per-type                | See each type below.                                                                                                                               |

### The `seq` invariant (A1)

The durable-streams idempotent producer (constraint C4) requires
`Producer-Seq` to start at 0 and increase by exactly 1 with no gaps, and the
outbox maps `Producer-Seq = seq` identically. Therefore:

- the **first** event of every entity has `seq === 0` and is always
  `entity_spawned`;
- **every** canonical event occupies a seq slot — a `state_snapshot` at seq N
  consumes N like any other event; nothing may skip;
- `seq` is allocated **only** by the entity's own Restate handler at outbox
  time (single-writer, D3). Harnesses never assign `seq` — they produce a
  `TimelineEventInit` (the envelope minus `v`/`entityId`/`seq`) and the outbox
  finalizes it via `finalizeEvent`.

Token deltas are **not** canonical events and take no `seq` (see
[Token deltas](#token-deltas)).

---

## The 15 event types

| Type              | Purpose                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `entity_spawned`  | Always seq 0. The entity's first event.                                                                    |
| `run_started`     | A wake began. Carries `runId`, wake source, harness kind, model.                                           |
| `message`         | A finalized conversation message (`user` / `assistant` / `system_note`).                                  |
| `tool_call`       | The model invoked a tool.                                                                                  |
| `tool_result`     | A tool returned (or errored).                                                                              |
| `reasoning`       | Finalized thinking/reasoning. **Display-only** — never re-projected into provider context.                |
| `state_snapshot`  | A complete materialization of entity state as of this event's seq (inclusive).                            |
| `summarization`   | A context-truncation boundary: context-bearing events `<= replacesThroughSeq` fold out of provider context. |
| `control`         | A control verb was applied (`interrupt` / `pause` / `resume` / `archive`).                                 |
| `error`           | An error occurred (harness / tool / platform / provider / projection).                                    |
| `run_finished`    | A wake ended. Carries outcome + token `usage`.                                                             |
| `child_spawned`   | This entity spawned a child.                                                                               |
| `child_finished`  | A child reported completion back to this entity.                                                          |
| `archived`        | Episode-terminal archive marker (D7). **Not** globally terminal — resurrection continues the seq counter. |
| `opaque`          | A lossless carrier for foreign records with no clean canonical home (R2/R3).                              |

> **Naming note:** the `control` type is what PLAN's T0.1 vocabulary called
> `signal`; it was renamed to match D8's decision to drop the POSIX signal
> vocabulary (DECISIONS A5).

---

## Payloads

### `entity_spawned` (seq 0)

```ts
{ entityType: string, parentId: string | null, spawnArgs?: Json, workspaceRef?: string }
```

`workspaceRef` is the workspace key (`<tenant>/<name>`) chosen at spawn and
never switched (D4).

### `run_started`

```ts
{
  runId: string,                       // unique per wake; every event of the run carries it
  wake: { source: WakeSource, from?: string },
  harness: "native" | "casdk",
  model?: string,
  detail?: Json,                       // harness-specific extras (e.g. CASDK session id)
}
```

`WakeSource` ∈ `spawn | message | steer_degraded | cron | control | system`.

### `message`

```ts
{ id: string, runId?: string, role: "user" | "assistant" | "system_note", content: ContentBlock[], from?: string }
```

- `id` is the stable message id that token deltas reference (`DeltaRecord.ref`).
- `system_note` is a platform-authored annotation (e.g. "child x finished").
  It is context-bearing but is rendered to providers as a **marked user
  message**, never the API-level system prompt.
- `from` is the sender entity URL for inter-agent messages.

### `tool_call`

```ts
{ runId: string, toolUseId: string, name: string, input: Json }
```

`toolUseId` is the provider tool-use id — the third component of the tool
idempotency key `(entityUrl, runId, toolUseId)`, the exactly-once contract.

### `tool_result`

```ts
{ runId: string, toolUseId: string, name?: string, content: ContentBlock[], detail?: Json, isError: boolean }
```

`detail` is structured result detail (diff, exitCode, streamRef, …) for rich
renderers; it is populated by the in-process tool layer, not by stream capture.

### `reasoning` (display-only)

```ts
{ id: string, runId?: string, text: string, encrypted?: string }
```

Never projected back into provider context (CASDK thinking signatures are
unforgeable); context assembly skips it.

### `state_snapshot`

```ts
{ state: Json, reason: "periodic" | "pre_archive" | "recovery", historyHole?: boolean }
```

A `state_snapshot` at seq N asserts: *"the state in `payload.state` is the
complete materialization of this entity after consuming all events with
`seq <= N`."* Fast-join: init from the snapshot, consume from N+1.
`historyHole: true` marks the D3 catastrophic-stream-loss path — consumers
must **not** gap-check across a history hole.

### `summarization`

```ts
{ runId?: string, summary: string, replacesThroughSeq: number /* < own seq */, detail?: Json }
```

For context assembly, context-bearing events with `seq <= replacesThroughSeq`
are superseded by `summary`. It does **not** delete or compact the stream —
history stays intact for UIs; only the LLM-facing projection folds.

### `control`

```ts
{ verb: "interrupt" | "pause" | "resume" | "archive", reason?: string, from?: string }
```

> An `interrupt`'s free-text `reason` cannot be attached by the interrupter to
> a busy run's `control` event (a shared handler can't write K/V, DECISIONS
> A8) — the event records the verb only.

### `error`

```ts
{ runId?: string, code?: string, message: string, source: "harness" | "tool" | "platform" | "provider" | "projection", detail?: Json }
```

### `run_finished`

```ts
{ runId: string, outcome: "success" | "error" | "interrupted", usage: RunUsage, durationMs?: number, detail?: Json }
```

### `child_spawned` / `child_finished`

```ts
// child_spawned
{ childId: string, childType: string, runId?: string, toolUseId?: string }
// child_finished
{ childId: string, outcome: "success" | "error" | "interrupted" | "archived", result?: Json }
```

### `archived`

```ts
{ reason: "idle" | "requested", snapshotSeq?: number }
```

A `state_snapshot(reason: "pre_archive")` immediately precedes it. **Not
globally terminal:** resurrection rehydrates from the catalog snapshot and
**continues the same seq counter** from `head_seq` — the next event after an
`archived` is the resurrecting wake's `run_started` (DECISIONS A10).

### `opaque`

```ts
{ origin: string /* e.g. "casdk", "pi-ai" */, kind: string, data: Json /* verbatim, lossless */ }
```

Foreign records with no clean canonical home round-trip losslessly here. A
cold CASDK rebuild replays `opaque(origin: "casdk")` records verbatim; every
other consumer may ignore them.

---

## Shared fragments

### `ContentBlock`

Deliberately tiny — `text` + `image` only for v1 (attachments are out of scope;
richer tool output goes in `tool_result.detail`):

```ts
{ type: "text", text: string }
{ type: "image", mimeType: string, data: string /* base64 */ }
```

### `RunUsage`

```ts
{
  inputTokens: number,        // UNCACHED input: fresh prompt + cache writes; cache reads excluded
  cacheReadTokens?: number,   // tokens read from the prompt cache
  outputTokens: number,       // completion tokens
  contextTokens?: number,     // cache-INCLUSIVE prompt size of the last step ("% of context used")
  steps?: number,
  costUsd?: number,
  attempt?: number,           // Restate attempt; consumers keep the latest attempt only (T7.4)
}
```

---

## Token deltas

Token deltas ride a **sibling `/deltas` stream** (addressing §4.2), never the
timeline. Rationale (deltas.ts header): the timeline's producer must be
0-based-gapless (A1/C4), but deltas are droppable and take no seq;
interleaving them would break the producer protocol, the timeline's exact
drift detector, retention divergence, and HTTP cacheability.

Contract:

- Deltas carry **no `seq`**. Each references the canonical event it streams
  toward via `ref` (the `message.payload.id`, `reasoning.payload.id`, or
  `toolUseId` the finalized event will carry).
- `idx` is a per-`ref` monotonic chunk counter for UI assembly. **Gaps are
  allowed** (dropped chunks are normal, not drift).
- **The finalized event always wins:** once the timeline carries the finalized
  event with `id == ref`, all buffered deltas for that ref are discarded.
  Deltas are never used to reconstruct state or context.
- `attempt` distinguishes Restate retry attempts; consumers render the highest
  attempt and drop the rest (T7.4).

Four delta kinds (discriminated on `kind`):

| Kind         | `ref` is        | Extra fields          |
| ------------ | --------------- | --------------------- |
| `text`       | message id      | `text`                |
| `reasoning`  | reasoning id    | `text`                |
| `tool_input` | toolUseId       | `text` (partial JSON) |
| `usage`      | runId           | `usage` (partial `RunUsage`) — best-effort mid-run counters; the authoritative figure is `run_finished.usage`. |

---

## Helpers (exported from `@teaspill/schema`)

| Function                                          | Purpose                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `finalizeEvent(init, { entityId, seq })`          | The outbox's single seq allocator: stamps `v`/`entityId`/`seq` and validates.                       |
| `parseTimelineEvent` / `safeParseTimelineEvent`   | Parse an unknown value into a canonical event (throwing / non-throwing).                             |
| `parseTimelineEventJson`                          | Parse one JSON-encoded stream record.                                                                |
| `checkSeqContiguity(events, { expectedFirstSeq })`| The client-side drift/gap detector primitive. A client joining from snapshot@N passes `N + 1`.      |
| `checkTimelineInvariants(events)`                 | Structural invariants beyond per-event shape (first event is `entity_spawned`, summarization bound). |
| `parseDeltaRecord` / `safeParseDeltaRecord`       | Parse a delta record.                                                                                |
| `EVENT_TYPES` / `DELTA_KINDS`                      | The frozen vocabularies as arrays.                                                                   |
