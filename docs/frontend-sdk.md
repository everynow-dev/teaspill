# Frontend SDK guide (`@teaspill/frontend-sdk`)

`@teaspill/frontend-sdk` materializes an agent's canonical timeline into UI
collections, subscribes to catalog rows over Electric shapes, and issues
commands through the gateway. It is a **framework-agnostic core** plus thin
optional React bindings (`@teaspill/frontend-sdk/react`; React is an optional
peer). Everything goes through the gateway (D6) — the SDK never touches the
internal services directly.

Sources: [frontend-sdk README](../packages/frontend-sdk/README.md),
`packages/frontend-sdk/src/{timeline,reducer,catalog,actions,react}.ts`,
DECISIONS A6/A7/D3. See [schema-reference.md](./schema-reference.md) for the
events the reducer folds and [streams.md](./streams.md) for stream layout.

The three layers, one per gateway route family:

- `timeline.ts` → the durable-streams `/streams/*` proxy (history + live tail),
- `catalog.ts` → Electric shapes over `/shapes/*` (entity registry rows),
- `actions.ts` → `/api/*` (spawn / send / control — **writes never bypass the
  gateway**, D6).

`reducer.ts` underneath is a **pure fold** (`initialTimelineState` →
`applyTimelineEvents` / `applyDeltaRecords`), unit-testable with fixtures and
usable on a server.

---

## `createAgentTimeline`

Materializes one entity's timeline stream into subscribable typed collections.

```ts
import { createAgentTimeline } from "@teaspill/frontend-sdk";

const timeline = createAgentTimeline(`${GATEWAY}${streamUrl}`, {
  auth: { token: () => refreshReadToken() }, // T1.4 read token, refreshed per request
  fromSnapshot: { seq: row.snapshotOffset }, // A7 fast-join (omit for full history)
  deltas: true,                              // subscribe to the sibling /deltas live stream
  onDrift: (d) => console.warn("timeline drift", d), // D3 seq-gap detector
});

timeline.subscribe((s) => render(s.timeline.messages, s.timeline.liveDeltas));
```

- `streamUrl` is the gateway stream URL (`/streams/t/<tenant>/agents/<type>/<id>/timeline`).
- `auth` accepts an API key or a `token()` resolver (the read-token path — see
  [auth.md](./auth.md)). The token is refreshed per request; on a 401 the
  stream is resumable, so reconnecting with a fresh token is cheap.
- `fromSnapshot` is the fast-join seek offset (below).
- `deltas: true` opens the sibling `/deltas` stream for live streaming chunks.

---

## The reducer's ordering rules

The reducer is the correctness core. Its three rules (full statement in
`reducer.ts`) make a **mid-stream join equivalent to a full replay** on fold
position, entity state, and the post-join window:

### 1. Seq idempotency (A6)

Records dedup by embedded canonical `seq`: a record with
`seq <= appliedThroughSeq` is **dropped** (counted, not drift). This absorbs
the durable-streams server's debounced-producer-checkpoint readmission window —
a server crash can readmit an already-acked append as a same-seq duplicate
stream record, so **readers must dedup by `seq`**.

### 2. Fast-join (A7 / A5)

A `state_snapshot` at seq N initializes `entityState`, then the reducer
consumes N+1, N+2, …. Collections cover only the **post-join window** (pre-N
history is a separate full read). Details:

- A **missing** promised snapshot surfaces as
  `drift.kind = "missing_join_snapshot"` — never silence.
- A snapshot at `seq > N` is accepted (the catalog `snapshot_offset` is a
  *floor*, A6 #5).

Fast-join lets a UI seek straight to the snapshot record (via
`snapshotOffset`/`snapshot_stream_offset` from the catalog row) instead of
scanning the timeline from 0.

### 3. Finalized event always wins (the frozen `deltas.ts` contract)

Delta chunks merge per `ref` in `idx` order (gaps are normal). The finalized
`message` / `reasoning` / `tool_call` (or `run_finished` for usage)
**supersedes** the buffer and all later chunks for that ref/run. Across Restate
retries, a higher `attempt` resets and a lower `attempt` drops (T7.4).

### Drift (D3 / A1)

A **forward seq gap** surfaces as `drift` + the `onDrift` callback with
resync-and-continue semantics (the UI keeps the live tail and can offer a
reload). The **only** sanctioned jump is a `state_snapshot(historyHole: true)`
(the D3 recovery path), which sets a `historyHole` flag instead of drift — the
reducer never gap-checks across a hole.

---

## `createAgentCatalog` / `useAgentCatalog`

Subscribe to entity registry rows over Electric shapes (through the gateway's
`/shapes/*` proxy) — live-updating lists filtered by type/status/parent/tags:

```ts
import { createAgentCatalog } from "@teaspill/frontend-sdk";

const catalog = createAgentCatalog({
  baseUrl: GATEWAY,
  filter: { type: "researcher", status: "active" },
});
catalog.subscribe((rows) => renderList(rows));
```

The React binding `useAgentCatalog(...)` wraps the same shape subscription.

> The SDK **vendored the pattern, not the package.** The upstream electric
> `@durable-streams/state` stack materializes streams of its own change-records
> against collection schemas (the stream-as-entity-truth model D8 dropped).
> teaspill's timeline carries frozen **domain** events, so the SDK keeps the
> shape of the pattern (stream → reducer → subscribable typed collections,
> offset-resumable) and implements the fold natively over
> `@durable-streams/client`, dropping the schema coupling and the TanStack
> dependency.

---

## The `actions` client

Issues commands through the gateway `/api/*` routes. Writes always go through
the gateway and require an API key (D6) — a browser read token cannot spawn /
send / control.

```ts
import { createActionsClient } from "@teaspill/frontend-sdk";

const actions = createActionsClient({ baseUrl: GATEWAY, auth: { apiKey } });

const { url, streamUrl } = await actions.spawn({ type: "researcher", args: { topic: "tea" } });
await actions.send(url, "one more angle: green vs black");
await actions.control(url, { verb: "interrupt" }); // interrupt | pause | resume | archive
```

`spawn` returns the new entity `url` + `streamUrl` — feed `streamUrl` straight
into `createAgentTimeline`.

---

## React bindings

`@teaspill/frontend-sdk/react` is lifecycle glue only, behind a separate export
so the core never loads React:

```tsx
import { useAgentTimeline, useAgentCatalog } from "@teaspill/frontend-sdk/react";

function AgentView({ streamUrl }: { streamUrl: string }) {
  const { timeline, liveDeltas, drift } = useAgentTimeline(streamUrl, {
    auth: { token: refreshReadToken },
    deltas: true,
  });
  return <Timeline messages={timeline.messages} streaming={liveDeltas} drift={drift} />;
}
```

---

## Mid-stream-join correctness (why it holds)

The whole design goal is that a browser can join a **live** agent at an
arbitrary point and see a correct, complete-going-forward view:

1. Read the catalog row → get `snapshotOffset` (the latest snapshot's seq) and
   `snapshot_stream_offset` (the opaque byte offset to seek to).
2. `createAgentTimeline(streamUrl, { fromSnapshot: { seq: snapshotOffset } })`
   seeks to the snapshot record, initializes entity state from it (rule 2),
   and folds forward from N+1.
3. Live deltas stream in and merge by `ref`; when each finalized event lands it
   wins (rule 3).
4. Duplicate records from the server's checkpoint window are dropped by seq
   (rule 1); a real forward gap raises drift (D3).

This is verified by `reducer.conformance.test.ts`, written **before** the
reducer: mid-stream join ≡ full replay, duplicate-idempotency, finalized-wins
interleaving, gap ⇒ drift vs duplicate ⇒ not-drift vs historyHole ⇒ sanctioned,
and out-of-snapshot joins.
