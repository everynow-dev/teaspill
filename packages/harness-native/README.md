# @teaspill/harness-native

Home of the harness interface (T3.1, `src/interface.ts` + `src/context.ts`)
and — later — the pi-ai step-durable loop (T3.2). **Interface STATUS:
PROPOSED — freezes with the T0.1 schema at gate G3.**

## Design notes (T3.1)

- `Harness.run({ entityId, runId, canonicalContext, wakeMessage, tools,
steerSource, signal, emitDelta, commitEvents? }) → { events, stateDelta,
usage }` per D5. `commitEvents` is the optional step-boundary outbox
  hand-off used by the step-durable native loop; committed events must not be
  repeated in the returned `events`.
- Events are returned as `TimelineEventInit` — **harnesses never allocate
  seq** (A1: single allocator, the entity handler's outbox).
- **Load-bearing clause:** every side-effecting tool invocation goes through
  Restate ingress with idempotency key `(entityUrl, runId, toolUseId)`
  (`toolIdempotencyKey`) — exactly-once under any retry granularity, both
  harnesses. `ToolContext` clients (`platform`, `workspace`) come pre-bound
  to the key.
- **`emitDelta` invariant:** fire-and-forget; never blocks, never throws;
  streams-server down ⇒ deltas drop, run proceeds, final events land via the
  outbox. `createSafeDeltaEmitter` is the reference wrapper; the invariant is
  tested in `src/interface.test.ts`.
- `SteerSource.drain()` returns-and-clears; harnesses poll at natural
  checkpoints (native: between steps; casdk: tool boundaries / light poll).
  Missed steers are re-drained at next wake start (T2.6).
- Context assembly: `selectContextEvents` (shared summarization fold +
  context-bearing filter) → per-harness `ContextAssembler<ProviderMessage>`.
  `reasoning` never re-enters provider context; `system_note` renders as a
  marked user message, never the API system prompt.

Dependency-light on purpose: only `@teaspill/schema` + type-only zod, so
`@teaspill/harness-casdk` and `@teaspill/agents-sdk` can import the contract.
