# @teaspill/frontend-sdk

Frontend SDK (T5.2): materializes an agent's canonical timeline into UI
collections, subscribes to catalog rows over Electric shapes, and issues
commands through the gateway. Framework-agnostic core + thin optional React
bindings (`@teaspill/frontend-sdk/react`; React is an optional peer).

```ts
import {
  createAgentTimeline,
  createAgentCatalog,
  createActionsClient,
  fromSnapshotForRow,
} from "@teaspill/frontend-sdk";

const actions = createActionsClient({ baseUrl: GATEWAY, auth: { apiKey } });
const { url, streamUrl } = await actions.spawn({ type: "researcher", args: { topic: "tea" } });

const timeline = createAgentTimeline(`${GATEWAY}${streamUrl}`, {
  auth: { token: () => refreshReadToken() }, // T1.4 read token, refreshed per request
  fromSnapshot: fromSnapshotForRow(row), // 0002:T1.5 fast-join from the catalog row (omit for full history)
  deltas: true, // sibling /deltas live stream
  onDrift: (d) => console.warn("timeline drift", d), // D3 seq-gap detector
});
timeline.subscribe((s) => render(s.timeline.messages, s.timeline.liveDeltas));

const catalog = createAgentCatalog({
  baseUrl: GATEWAY,
  filter: { type: "researcher", status: "active" },
});
```

## Design note (T5.2, L)

**Layering.** `reducer.ts` is a pure fold (`initialTimelineState` →
`applyTimelineEvents`/`applyDeltaRecords`), unit-testable with fixtures and
usable in any framework or on a server. `timeline.ts` wires it to
`@durable-streams/client@0.2.6` (pinned to match the `:0.1.4` server, A6)
through the gateway `/streams/*` proxy; `catalog.ts` wraps
`@electric-sql/client` shapes through `/shapes/*`; `actions.ts` posts to
`/api/*` (writes never bypass the gateway, D6). `react.ts` is lifecycle glue
only and lives behind a separate export so the core never loads React.

**Reducer ordering rules** (full statement in `reducer.ts` header):

1. **Seq idempotency (A6)** — records dedup by embedded canonical `seq`
   (`seq <= appliedThroughSeq` ⇒ dropped, counted, not drift). This absorbs
   the server's debounced-producer-checkpoint readmission window.
2. **Fast-join (A7/A5)** — snapshot@N initializes `entityState`, then N+1,
   N+2…; collections cover only the post-join window (pre-N history is a
   separate full read). A missing promised snapshot is
   `drift.kind="missing_join_snapshot"`, never silence. A snapshot at
   `seq > N` is accepted (catalog `snapshot_offset` is a floor, A6 #5).
3. **Finalized event always wins** (frozen `deltas.ts` contract) — delta
   chunks merge per `ref` in `idx` order (gaps normal); the finalized
   `message`/`reasoning`/`tool_call` (or `run_finished` for usage)
   supersedes the buffer and all later chunks for that ref/run; higher
   Restate `attempt` resets, lower drops (T7.4).

**Drift (D3/A1).** A forward seq gap surfaces `drift` + `onDrift` with
resync-and-continue semantics (UI keeps the live tail; offer a reload). The
only sanctioned jump is a `state_snapshot(historyHole: true)` (D3 recovery),
which sets `historyHole` instead — never gap-check across a hole
(the timelines & events concept page, https://teaspill.everynow.dev/concepts/timelines-events).

**`@durable-streams/state`: vendored the pattern, not the package.** The
electric `entity-stream-db.ts` + `@durable-streams/state` stack materializes
streams of its own `StateEvent` change-records (insert/update/delete against
collection schemas, TanStack DB collections, actions, principals) — i.e. the
stream-as-entity-truth model D8 explicitly dropped. Teaspill's timeline
carries frozen A5 _domain_ events, so we keep the shape of the pattern
(stream → reducer → subscribable typed collections, offset-resumable) and
implement the fold natively over `@durable-streams/client` reads, dropping
the schema coupling and the TanStack dependency.

**Conformance tests first.** `reducer.conformance.test.ts` was written before
the reducer: mid-stream join (snapshot@N + N+1..N+k ≡ full replay on fold
position, entity state, and the post-join window), A6 duplicate idempotency
(each-event-twice ≡ once), finalized-wins delta interleaving, gap ⇒ drift vs
duplicate ⇒ not-drift vs historyHole ⇒ sanctioned, and out-of-snapshot joins.
`timeline.test.ts` re-drives the real client against an in-process fake of
the long-poll protocol. Fixtures (`fixtures.ts`) build every event through
the frozen schema's `finalizeEvent` and are reusable by the T6.3 kit.
