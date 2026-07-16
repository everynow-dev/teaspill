# Entity addressing & naming model (T0.2)

Status: spec, ready to implement. Owner package (later): `packages/schema` (dropped in by a follow-up task; **do not** create it here). This document is the single source of truth for how entities, streams, workspaces, and Restate objects are named and derived from one another.

Implements/depends on: **D1** (catalog `entities.url` pk, streams as history), **D2** (`agent/<type>` keyed by instance id, `steer/<entityId>`, cron object), **D4** (`workspace/<key>`, workspace chosen at spawn, no mid-session switch), **D8** (single-tenant per deployment — *a tenant is a deployment*). Feeds: T0.1 (event `entityId`), T1.2 (gateway `/streams/*`, `/shapes/*`, `/api/*`), T1.3 (catalog columns + Electric shapes), T2.1/T2.2 (agent object + outbox producer id), T2.6 (steerbox), T4.1 (workspace + stdout stream).

---

## 0. TL;DR

| Thing | Canonical form | Example (default tenant) |
|---|---|---|
| Entity URL (`entities.url` pk = **entityId**) | `/t/<tenant>/a/<type>/<id>` | `/t/default/a/researcher/01j9z8k3q...` |
| Entity URL, gateway HTTP short form | `/a/<type>/<id>` | `/a/researcher/01j9z8k3q...` |
| Timeline stream (server key) | `/t/<tenant>/agents/<type>/<id>/timeline` | `/t/default/agents/researcher/01j9.../timeline` |
| Deltas stream (sibling, optional — see §4) | `/t/<tenant>/agents/<type>/<id>/deltas` | `/t/default/agents/researcher/01j9.../deltas` |
| Workspace stdout stream | `/t/<tenant>/workspaces/<name>/stdout` | `/t/default/workspaces/a-researcher-01j9.../stdout` |
| Gateway stream URL | `/streams` + `<streamPath>` | `/streams/t/default/agents/.../timeline` |
| Restate agent object | service `agent.<type>`, key `<id>` | `agent.researcher` / `01j9z8k3q...` |
| Restate steer object | service `steer`, key `<entityUrl>` | `steer` / `/t/default/a/researcher/01j9...` |
| Restate workspace object | service `workspace`, key `<tenant>/<name>` | `workspace` / `default/a-researcher-01j9...` |
| Restate cron object | service `cron`, key `<name>` | `cron` / `nightly-report` |

**Segment charset (all of `<tenant> <type> <id> <name> <cron-key>`):** `^[a-z0-9][a-z0-9_-]*$` — lowercase alnum, `-`, `_`; must start alnum. Max lengths: tenant 32, type 48, id 64, workspace name 64, cron key 64. No `/`, `.`, `%`, uppercase, or unicode inside a segment; `/` is reserved as the path separator only.

---

## 1. The tenant prefix (reserved now, single default)

**D8 says a tenant *is* a deployment** — there is exactly one tenant per running stack, and no runtime cross-tenant isolation is built. So why bake `/t/<tenant>` into every identifier?

Because the identifiers (`entities.url`, stream paths) are **durable and externally referenced** (browsers hold stream URLs, catalog rows persist, backups carry them). Retrofitting a namespace segment onto already-issued URLs later is the "painful" migration the plan warns about. Reserving the segment now costs one constant prefix and makes future multi-tenancy — or, more realistically for a single-tenant product, *merging/migrating/federating deployments* without URL collisions — a config change rather than a data migration.

**Concretely:**
- Each deployment sets its tenant id once, via config (`TEASPILL_TENANT`, default `"default"`). It is a constant for the life of the deployment.
- Every canonical identifier carries `/t/<tenant>/…`. In a single-tenant deployment that is always `/t/default/…` (or whatever the deployment picked).
- Because the tenant is a deployment-level constant, it is **not** threaded through Restate keys (§6) — the whole Restate cluster is one tenant. The prefix lives only where identifiers are persisted or handed to clients: the entity URL and the stream paths.
- The gateway accepts and emits a **tenant-relative short form** `/a/<type>/<id>` and `/streams/agents/<type>/<id>/…` for ergonomics; it expands them to the canonical tenant-qualified form using the deployment tenant. Canonical form is what gets stored.

This does **not** contradict D8: D8 drops *runtime* multi-tenancy (principals, per-tenant isolation, tenant-aware control flow). We are only reserving a *naming* segment, which D8/T0.2 explicitly calls for ("reserve a prefix segment ... even though we're single-tenant").

---

## 2. Entity URL scheme

### 2.1 Canonical form
```
/t/<tenant>/a/<type>/<id>
```
- `/t/<tenant>` — namespace segment (§1).
- `a` — the entity marker (mnemonic: **a**gent / **a**ddressable entity). Literal, fixed.
- `<type>` — the agent/entity type = the `defineAgent` type name (T6.1). Also the Restate service discriminator (§6).
- `<id>` — the instance id (§3).

This exact string is:
- the catalog **`entities.url` primary key** (D1, T1.3),
- the value of **`entityId`** in every canonical timeline event (T0.1),
- the **`steer/<entityId>`** Restate key (§6),
- the durable-streams **`Producer-Id`** for the outbox (§7).

"entityId" and "entity url" are the same string throughout the system. There is no separate opaque id.

### 2.2 Gateway HTTP short form
The gateway exposes commands under `/api/*` (T1.2). For addressing an entity in a URL path or path parameter, the short form omits the tenant:
```
/a/<type>/<id>
```
The gateway expands `/a/<type>/<id>` → `/t/<deployment-tenant>/a/<type>/<id>` before touching the catalog or Restate. Fully-qualified canonical URLs are also accepted verbatim. Round-trips: `toHttpForm(entityUrl(...))` and `fromHttpForm(...)` (§8).

### 2.3 Charset & length
Every segment matches `^[a-z0-9][a-z0-9_-]*$`. Rationale:
- **Lowercase only** — avoids case-folding ambiguity on case-insensitive filesystems (macOS dev boxes) where the durable-streams server writes one file per stream, and avoids "same entity, two URLs" bugs.
- **`[a-z0-9_-]`, no `.`** — `.` survives durable-streams' on-disk encoder but invites `.`/`..` path-traversal ambiguity in tooling; ban it. `_` and `-` are safe and cover slug/ULID needs.
- **No `/` inside a segment** — `/` is the structural separator; keeping it out of segments makes `parseEntityUrl` a fixed 3-segment match and keeps stream-path derivation unambiguous.
- Lengths (tenant 32 / type 48 / id 64 / name 64): keep the full timeline stream path comfortably within the durable-streams 120-char legible-filename budget (§4, constraint C2).

---

## 3. Instance-id rules

### 3.1 Format & generation
- **Default: lowercase ULID** (26 chars, Crockford base32 lowercased). Generated by `newInstanceId()` (§8), backed by a ULID lib (`ulidx` or equivalent).
- Chosen over UUIDv4 because ULIDs are **lexicographically time-sortable**: `ORDER BY id` ≈ creation order, which is convenient for Electric shape `orderBy` and for human-scannable listings. Also shorter and hyphen-free (fits the segment charset directly).
- A generated ULID trivially satisfies `^[a-z0-9][a-z0-9_-]*$`.

### 3.2 Caller-supplied ids (deterministic spawn)
Callers **may** supply an explicit `id` at spawn instead of taking a generated ULID. This enables **idempotent / deterministic spawn**: e.g. a parent spawning one child per subtask can key the child id off `(parentId, role)` so a retried spawn reattaches to the same instance instead of creating a duplicate. This composes with D2 (spawn = one-way durable send) and Restate's get-or-create-by-key object model.

Supplied ids must match `^[a-z0-9][a-z0-9_-]{0,63}$` (validated by `assertSeg(ID_RE, …)`). Reject non-conforming ids at the gateway with a clear 400.

### 3.3 Uniqueness & collision handling
- The unique identity is the full url `(tenant, type, id)` — i.e. `entities.url`.
- **Restate is the arbiter, not the catalog.** `restateAgentKey(url)` maps to a single virtual object; a second spawn with the same id lands on the **same** object. The agent object's own handler decides:
  - object has **no state yet** → first spawn, initialize.
  - object **already has state** → re-spawn. Default policy: **no-op reattach** (return the existing entity; this is the point of deterministic spawn). If the re-spawn args differ materially from the original, the handler emits an `error` event on the timeline (never silently) and still does not re-initialize.
- Catalog insert is `INSERT … ON CONFLICT (url) DO NOTHING` from inside the handler (D1: catalog written only via `ctx.run`), so the row is idempotent too.
- **Random ULID collision** with an existing row is astronomically unlikely and, if it ever happened, is handled by the exact same reattach path — a generated id is not privileged over a supplied one.

---

## 4. Stream path derivation

Streams are the durable-streams server's unit; each path is an independent append-only stream (its own file). Paths below are the **server keys**; clients reach them through the gateway at `/streams` + `<path>` (T1.2 proxies `/streams/*`).

### 4.1 Timeline (authoritative history, D1)
```
/t/<tenant>/agents/<type>/<id>/timeline
```
One per entity. Carries the canonical event stream (T0.1). Note the collection segment is `agents` (plural) here vs the `a` entity marker in the URL — this matches the plan's literal forms (`/a/<type>/<id>` entity, `/agents/<type>/<id>/timeline` stream, and the T1.4 JWT prefix-claim example `/streams/agents/team-x/`). Both are derivable from the entity url; see `timelineStreamPath`.

### 4.2 Deltas (token deltas — *sibling stream option*)
```
/t/<tenant>/agents/<type>/<id>/deltas
```
D5/T0.1/T5.1 leave open whether token deltas ride the timeline as non-`seq` sub-events **or** a sibling stream. T0.2 only **reserves the name** for the sibling option; whether it is used is T0.1/T5.1's call. If deltas interleave into the timeline, this path is simply never created.

### 4.3 Workspace stdout (T4.1)
Keyed by **workspace**, not entity (a workspace may be shared and outlives a single run):
```
/t/<tenant>/workspaces/<name>/stdout                       # per-workspace, coarse
/t/<tenant>/workspaces/<name>/exec/<runId>/stdout          # per-exec, isolated (recommended for concurrency clarity)
```
T4.1 streams long-exec stdout/stderr here in chunks (R4: bulk out-of-band). Granularity (single rolling stdout vs per-exec) is T4.1's decision; both derivations are provided (`workspaceStdoutStreamPath`, `workspaceExecStdoutStreamPath`). `<runId>` uses the same id charset.

### 4.4 durable-streams constraints found (with refs)

Checked against `../electric/packages/durable-streams-rust` (the pinned server; the referenced root `PROTOCOL.md` is not present in this checkout — findings below are read directly from the server source, which is authoritative for behavior):

- **C1 — the stream name is the HTTP path, used verbatim as the logical key.** `handlers.rs` routes `PUT/POST/GET/HEAD/DELETE` on `req.path` and calls `store.get(&path)` / `store.create(&path, …)` with the raw path (`handlers.rs:266–275, 924, 562`). `store.recover` keys its meta map on `meta.path` (`store.rs:663, 692`). **Consequence:** slashes are free, structural separators — a nested path like `/t/default/agents/x/y/timeline` is one flat key; there is no directory/prefix listing and none is needed (a timeline is one exact path).
- **C2 — on-disk filename encoding is lossy but collision-safe.** `encode_path` (`store.rs:1214`) keeps `[A-Za-z0-9._-]`, turns every other char (including `/`) into `+`, and truncates to **120 chars**; the actual file is `"{encoded}~{id}"` where `id` is a per-stream unique number (`store.rs:1086`). **Consequences:** (a) our `[a-z0-9_-]`-only segments never hit the lossy branch, so on-disk names stay legible (`+t+default+agents+…`); (b) truncation of very long paths cannot cause a *logical* collision (the logical key is the full untruncated `meta.path`; the `~id` suffix disambiguates files), but it does hurt debuggability — hence the length caps in §2.3 keep the readable portion intact.
- **C3 — streams must be created (PUT) before append (POST); append to a missing stream is 404** (`handlers.rs:924–926`). **Consequence for T2.2:** the outbox must `PUT` the timeline stream once at `entity_spawned` (idempotent — a re-PUT of an existing stream is a no-op create) before its first append. Same for the deltas/stdout streams at first use.
- **C4 — idempotent producer identity is `(Producer-Id: string, Producer-Epoch: u64, Producer-Seq: u64)`** (`handlers.rs:22–25, 806–890`). Sequence rules from `validate_producer` (`handlers.rs:850`): a new producer (or new epoch) **must** start at `seq == 0`; thereafter strictly `+1`; `seq <= last_seq` ⇒ `Duplicate` (idempotent no-op); any other gap ⇒ rejected with the expected seq; a lower epoch ⇒ `StaleEpoch`. See §7 for the mapping and the one cross-task caveat it creates.

---

## 5. Workspace key derivation (D4)

A workspace is a `workspace/<key>` virtual object fronting a real environment. Chosen at spawn, never switched mid-session (D4). `workspaceRef` (the key) lives in agent K/V state.

**Key form:** `<tenant>/<name>` — tenant-qualified so backups/migrations stay unambiguous, matching the stream paths.

**`<name>` comes from one of two places:**
- **Private (default, 1:1 with the entity):** `a-<type>-<id>` — derived from the owning entity url by `privateWorkspaceKey(url)`. Traceable back to its agent, unique by construction.
- **Shared / named:** a caller-supplied `<name>` (charset `^[a-z0-9][a-z0-9_-]*$`, ≤64) passed at spawn. Multiple entities may set their `workspaceRef` to the same shared key; per-workspace single-writer serialization (D4) still holds because it is keyed on the workspace, not the entity.

The workspace stdout stream (§4.3) derives from the same key, so an entity's `workspaceRef` fully determines where to read its exec output.

---

## 6. Restate key mapping (D2/D4)

Restate identifies a virtual object by `(service name, key)`. Tenant is **not** in any Restate key — the whole cluster is one tenant (D8), so the deployment tenant is implicit.

| Object | Service name | Key | Derivation | Notes |
|---|---|---|---|---|
| Agent | `agent.<type>` | `<id>` (instance id) | `restateAgentKey(url)` | Type is in the service name because each `defineAgent` type registers as its own Restate service (T6.1). Key = instance id per D2. `(service, key)` + deployment tenant fully reconstruct the url. |
| Steerbox | `steer` | `<entityUrl>` (full canonical url) | `steerKey(url)` | One `steer` service for all types, so the key must disambiguate type+id ⇒ use the whole url (D2: `steer/<entityId>`, entityId = url). |
| Workspace | `workspace` | `<tenant>/<name>` | `restateWorkspaceKey(key)` | Same string as the workspace key (§5). One service for all workspaces. |
| Cron | `cron` | `<name>` | `restateCronKey(name)` | Caller-named self-rescheduling object (D2/T2.4). |

**On "agent key = instance id" (D2 fidelity):** D2 says *"`agent/<type>` keyed by instance id."* We honor that literally — service `agent.<type>`, key `<id>`. We do **not** add tenant to the key (D8: one tenant per deployment). The `.` in `agent.<type>` (vs `/`) is a cosmetic choice for a valid Restate/RPC service identifier; nothing depends on the separator.

---

## 7. durable-streams outbox producer mapping (T2.2 hand-off)

For the projection outbox (D3 / T2.2), map our per-entity monotonic `seq` onto the producer protocol (C4):
- `Producer-Id` = the **entity url** (`timelineProducerId(url)` = `url`). One producer per entity ⇒ exactly D3's `(entityId, seq)` dedup key.
- `Producer-Seq` = the canonical `seq`.
- `Producer-Epoch` = bumped only on a deliberate producer reset (e.g. post-catastrophic-stream-loss `state_snapshot` restart, D3); normal operation keeps epoch constant.

**Cross-task caveat (flag for T0.1 + T2.2):** C4 requires `Producer-Seq` to **start at 0 and be gapless `+1`**. So the canonical per-entity `seq` (T0.1) must be **0-based and gapless per entity**, or T2.2 must carry a small offset map (`producerSeq = seq - firstSeq`). Recommendation: define canonical `seq` as 0-based gapless per entity in T0.1 so the mapping is identity. If a `state_snapshot`-and-continue ever needs to *reset* the stream, do it by bumping `Producer-Epoch` and restarting `Producer-Seq` at 0 (append a snapshot event first), never by leaving a seq gap.

---

## 8. Electric shape ergonomics (T1.3 hand-off)

Electric shape subsets use a Postgres `where` expression with positional `params` (`../electric/packages/typescript-client/src/types.ts:93–105`; `WHERE_QUERY_PARAM`/`WHERE_PARAMS_PARAM` in `constants.ts:13–15`). The clean, well-supported path is **scalar-column equality with positional params**. The addressing scheme is designed so every subscription a UI needs is a scalar-column filter:

| UI subscription | Shape `where` | Backing column |
|---|---|---|
| All entities of a type | `type = $1` | `entities.type` |
| Children of an entity | `parent = $1` | `entities.parent` (stores the parent's url) |
| By lifecycle | `status = $1` | `entities.status` |
| Scope to a tenant (future) | `tenant = $1` | **new** `entities.tenant` (see below) |

**Recommendation 1 — add a denormalized `tenant` column to `entities`.** The tenant is embedded in the `url` pk, but filtering by it via `url LIKE '/t/default/%'` is a text-prefix scan and awkward to parameterize. A plain `tenant text not null` column (populated from the url at write time) makes tenant scoping a clean `tenant = $1` equality and is future-proof for §1. Cheap now; add it in T1.3 alongside `type`/`parent`/`status`.

**Recommendation 2 — keep tags in the normalized `entity_tags(url, tag)` table, not (only) `tags jsonb`.** This is already flagged in T1.3; addressing confirms it. Electric `where` ergonomics strongly favor scalar equality with positional params; jsonb containment (`tags @> $1`, `tags ->> …`) is not cleanly parameterizable, is harder for Electric to plan/replicate, and complicates per-tag shape subscriptions. A per-tag subscription becomes a trivial shape over `entity_tags` with `where tag = $1` (or a subquery join back to `entities`). Keep `tags jsonb` on `entities` if convenient for whole-row reads, but drive **tag-filtered shapes** off `entity_tags`.

**Note:** no shape needs to filter on the `url`/stream-path *structure* itself — everything decomposed from the url that a filter wants (`tenant`, `type`, `parent`, `status`) is a first-class column. The url stays an opaque-to-SQL identifier. This is the whole reason the scheme "filters cleanly."

---

## 9. Reference implementation (TypeScript)

Pure, dependency-light derivation functions. These go into `packages/schema` later (via a follow-up task, not T0.2). No I/O, no clock except `newInstanceId`. Every function validates its inputs and throws on malformed identifiers — malformed identifiers must never reach the catalog, Restate, or the streams server.

```ts
// packages/schema/src/addressing.ts  (reference — dropped in by a later task)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-deployment tenant id (D8: a tenant is a deployment). Config: TEASPILL_TENANT. */
export const DEFAULT_TENANT = 'default'

export const ENTITY_MARKER = 'a' // /t/<tenant>/a/<type>/<id>
export const STREAM_COLLECTION = 'agents' // /t/<tenant>/agents/<type>/<id>/...
export const WORKSPACE_COLLECTION = 'workspaces'
export const GATEWAY_STREAMS_PREFIX = '/streams'

const seg = (max: number): RegExp =>
  new RegExp(`^[a-z0-9][a-z0-9_-]{0,${max - 1}}$`)

export const TENANT_RE = seg(32)
export const TYPE_RE = seg(48)
export const ID_RE = seg(64)
export const WORKSPACE_NAME_RE = seg(64)
export const CRON_KEY_RE = seg(64)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityRef {
  tenant: string
  type: string
  id: string
}
export interface WorkspaceRef {
  tenant: string
  name: string
}
/** A resolved Restate virtual-object target. */
export interface RestateTarget {
  service: string
  key: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertSeg(re: RegExp, v: string, what: string): void {
  if (typeof v !== 'string' || !re.test(v)) {
    throw new Error(`invalid ${what}: ${JSON.stringify(v)} (must match ${re})`)
  }
}

// ---------------------------------------------------------------------------
// Entity URL  (== entities.url pk == entityId)
// ---------------------------------------------------------------------------

/** Canonical entity url: `/t/<tenant>/a/<type>/<id>`. */
export function entityUrl(tenant: string, type: string, id: string): string {
  assertSeg(TENANT_RE, tenant, 'tenant')
  assertSeg(TYPE_RE, type, 'type')
  assertSeg(ID_RE, id, 'id')
  return `/t/${tenant}/${ENTITY_MARKER}/${type}/${id}`
}

const ENTITY_URL_RE =
  /^\/t\/([a-z0-9][a-z0-9_-]*)\/a\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/

/** Parse a canonical entity url back into its parts (revalidates lengths). */
export function parseEntityUrl(url: string): EntityRef {
  const m = ENTITY_URL_RE.exec(url)
  if (!m) throw new Error(`not a canonical entity url: ${JSON.stringify(url)}`)
  const [, tenant, type, id] = m
  assertSeg(TENANT_RE, tenant, 'tenant')
  assertSeg(TYPE_RE, type, 'type')
  assertSeg(ID_RE, id, 'id')
  return { tenant, type, id }
}

export function isEntityUrl(url: string): boolean {
  try {
    parseEntityUrl(url)
    return true
  } catch {
    return false
  }
}

const SHORT_FORM_RE = /^\/a\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/

/** Canonical url -> gateway short form `/a/<type>/<id>` (default tenant only). */
export function toHttpForm(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url)
  return tenant === DEFAULT_TENANT ? `/${ENTITY_MARKER}/${type}/${id}` : url
}

/** Gateway short form (or already-canonical url) -> canonical url. */
export function fromHttpForm(path: string, tenant: string = DEFAULT_TENANT): string {
  const m = SHORT_FORM_RE.exec(path)
  if (m) return entityUrl(tenant, m[1], m[2])
  return parseEntityUrl(path) && path // throws if neither form
}

// ---------------------------------------------------------------------------
// Instance ids
// ---------------------------------------------------------------------------

// import { ulid } from 'ulidx'  // (or any spec-compliant ULID generator)
declare function ulid(): string

/** Fresh instance id: lowercase ULID (time-sortable, 26 chars, url-safe). */
export function newInstanceId(): string {
  return ulid().toLowerCase()
}

/** Validate a caller-supplied id (deterministic spawn). Throws if invalid. */
export function assertInstanceId(id: string): void {
  assertSeg(ID_RE, id, 'id')
}

// ---------------------------------------------------------------------------
// Stream paths (durable-streams server keys; prefix with GATEWAY_STREAMS_PREFIX
// for the client-facing URL)
// ---------------------------------------------------------------------------

export function timelineStreamPath(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url)
  return `/t/${tenant}/${STREAM_COLLECTION}/${type}/${id}/timeline`
}

export function deltasStreamPath(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url)
  return `/t/${tenant}/${STREAM_COLLECTION}/${type}/${id}/deltas`
}

/** Server stream key -> gateway URL a client GETs. */
export function gatewayStreamUrl(streamPath: string): string {
  return `${GATEWAY_STREAMS_PREFIX}${streamPath}`
}

// ---------------------------------------------------------------------------
// Workspaces (D4)
// ---------------------------------------------------------------------------

/** Workspace key: `<tenant>/<name>`. */
export function workspaceKey(tenant: string, name: string): string {
  assertSeg(TENANT_RE, tenant, 'tenant')
  assertSeg(WORKSPACE_NAME_RE, name, 'workspace name')
  return `${tenant}/${name}`
}

export function parseWorkspaceKey(key: string): WorkspaceRef {
  const i = key.indexOf('/')
  if (i <= 0) throw new Error(`invalid workspace key: ${JSON.stringify(key)}`)
  const tenant = key.slice(0, i)
  const name = key.slice(i + 1)
  assertSeg(TENANT_RE, tenant, 'tenant')
  assertSeg(WORKSPACE_NAME_RE, name, 'workspace name')
  return { tenant, name }
}

/** Default private (1:1) workspace key for an entity. */
export function privateWorkspaceKey(url: string): string {
  const { tenant, type, id } = parseEntityUrl(url)
  return workspaceKey(tenant, `${ENTITY_MARKER}-${type}-${id}`)
}

export function workspaceStdoutStreamPath(key: string): string {
  const { tenant, name } = parseWorkspaceKey(key)
  return `/t/${tenant}/${WORKSPACE_COLLECTION}/${name}/stdout`
}

export function workspaceExecStdoutStreamPath(key: string, runId: string): string {
  const { tenant, name } = parseWorkspaceKey(key)
  assertSeg(ID_RE, runId, 'runId')
  return `/t/${tenant}/${WORKSPACE_COLLECTION}/${name}/exec/${runId}/stdout`
}

// ---------------------------------------------------------------------------
// Restate key mapping (D2/D4). Tenant is implicit (D8: one tenant/deployment).
// ---------------------------------------------------------------------------

/** Agent virtual object: service `agent.<type>` (type in the service name because
 *  each defineAgent type registers its own Restate service, T6.1), key `<id>`. */
export function restateAgentKey(url: string): RestateTarget {
  const { type, id } = parseEntityUrl(url)
  return { service: `agent.${type}`, key: id }
}

/** Steerbox virtual object: service `steer`, key = full canonical entity url. */
export function steerKey(url: string): RestateTarget {
  parseEntityUrl(url) // validate
  return { service: 'steer', key: url }
}

/** Workspace virtual object: service `workspace`, key `<tenant>/<name>`. */
export function restateWorkspaceKey(key: string): RestateTarget {
  parseWorkspaceKey(key) // validate
  return { service: 'workspace', key }
}

/** Cron virtual object: service `cron`, key `<name>`. */
export function restateCronKey(name: string): RestateTarget {
  assertSeg(CRON_KEY_RE, name, 'cron key')
  return { service: 'cron', key: name }
}

// ---------------------------------------------------------------------------
// durable-streams outbox producer identity (D3 / T2.2)
// ---------------------------------------------------------------------------

/** Producer-Id for an entity's timeline outbox == the entity url. */
export function timelineProducerId(url: string): string {
  parseEntityUrl(url) // validate
  return url
}
```

---

## 10. Open questions / cross-task flags

1. **Canonical `seq` must be 0-based gapless per entity** (or T2.2 carries an offset) to satisfy the producer protocol (§7). Confirm in T0.1.
2. **`entities.tenant` column** — add in T1.3 (§8, Rec 1). Not blocking, but cheaper now than later.
3. **Delta framing** — §4.2 reserves the sibling `/deltas` path; T0.1/T5.1 decide whether it's used vs interleaved. No addressing change either way.
4. **Workspace stdout granularity** — per-workspace vs per-exec stream (§4.3) is T4.1's call; both derivations provided.
5. **Restate service-name separator** — `agent.<type>` uses `.`; confirm it satisfies Restate's service-name grammar during T2.0/T2.1 (nothing depends on the separator; swap to `agent_<type>` or `agent/<type>` if needed).
