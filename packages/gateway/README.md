# @teaspill/gateway

The platform's **single entrypoint** (T1.2, D6). Everything external —
developer services, UIs, the CLI — talks to teaspill through this service;
restate/postgres/electric/durable-streams are never exposed directly.

## Routes

| Route                           | What it does                                                                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                   | Liveness (public — compose healthcheck).                                                                                                                                                                                                                                                  |
| `POST /api/spawn`               | `{ type, id?, args?, parent? }` → Restate ingress one-way send `agent.<type>/<id>/spawn/send`. `id` defaults to a fresh lowercase ULID; caller-supplied ids enable deterministic/idempotent spawn (addressing.md §3.2). Returns `202 { url, streamPath, streamUrl, restate }`.            |
| `POST /api/a/:type/:id/send`    | Message wake → `agent.<type>/<id>/message/send`. Body = the message, verbatim. Also accepts the canonical form `/api/t/:tenant/a/:type/:id/send` (deployment tenant only).                                                                                                                |
| `POST /api/a/:type/:id/control` | `{ verb: interrupt\|pause\|resume\|archive, reason? }` → the verb's OWN agent-object handler (`interrupt`/`pause`/`resume`/`archive`), NOT a single `control` handler (0001:A8: the verbs are different handler kinds — `interrupt` SHARED, the rest EXCLUSIVE). Per-verb dispatch through the `AGENT_HANDLERS` map (0002:A1; a prior single-`control` entry 404'd every control verb at ingress, caught on the first live interrupt in 0002:T4.2). T2.5 verbs; D8 dropped POSIX signals.                                                                                                                                                         |
| `/streams/*`                    | Byte-exact proxy to the durable-streams server (`GET`/`HEAD`/`PUT`/`POST`/`DELETE`). **R5:** long-poll parking, `ETag`/`Cache-Control`, `Stream-Next-Offset`/`Stream-Cursor`/`Stream-Closed`, offset & `live` query params all pass through untouched; responses stream (never buffered). |
| `/shapes/*`                     | Proxy to Electric: `/shapes/v1/shape?…` → `ELECTRIC_URL/v1/shape?…`, headers/params preserved (GET/HEAD).                                                                                                                                                                                 |
| `/registry/*`                   | Deployment registration → Restate **admin API**. Allowlist: all methods on `/deployments*`, GET `/services*`, GET `/health`. Bodies forwarded **as-is** — see networking note below.                                                                                                      |

Command sends forward a client `Idempotency-Key` header verbatim to Restate
ingress (dedup within retention, default 24 h — SPIKE-RESTATE.md (c)).

## Auth

API keys (D6): every route except `/health` requires
`Authorization: Bearer <key>`.

- Keys are 256-bit random values (`newApiKey()` → `tsp_…`). Postgres stores
  **sha256 hex** in `api_keys.hash` (@teaspill/catalog); lookup is by digest,
  comparison is constant-time, `revoked_at IS NOT NULL` is rejected.
  (sha256 — not bcrypt/argon2 — is deliberate: those exist to slow
  brute-force of low-entropy passwords and are salted, which breaks indexed
  lookup; for high-entropy random keys a fast digest is the standard choice
  and matches the frozen T1.3 schema. See `src/auth.ts`.)
- Minting a key today (CLI ergonomics land in T6.2):

  ```ts
  import { newApiKey, hashApiKey } from "@teaspill/gateway";
  const key = newApiKey(); // show once, never store
  // INSERT INTO api_keys (hash, label) VALUES (hashApiKey(key), 'my-service');
  ```

- `GATEWAY_BOOTSTRAP_API_KEY` (dev only): a literal key accepted without a
  database row, so a fresh stack is usable before any key exists.

### Optional JWT read path (T1.4, D6 fast-follow)

When `GATEWAY_JWT_SECRET` is set, a **browser** can read `/streams/*` and
`/shapes/*` directly with a short-lived HS256 token instead of an API key —
preserving the caching/resumability of the chattiest traffic without the
developer proxying every read. Developers mint tokens with
`@teaspill/agents-sdk`:

```ts
import { mintReadToken } from "@teaspill/agents-sdk";
const jwt = await mintReadToken({
  // one entity prefix covers both /timeline and /deltas (casdk-mapping §8.5);
  // trailing slash = clean boundary (won't leak into a sibling /x1extra/…)
  pfx: "/streams/t/default/agents/researcher/x1/",
  ttlSeconds: 300, // keep it short — reconnecting is cheap
  secret: process.env.GATEWAY_JWT_SECRET!,
});
// hand `jwt` to the browser; it sends `Authorization: Bearer <jwt>`
```

**Rules (enforced in `app.ts`, verified in `src/jwt.ts`):**

- **Reads only.** A read token is honoured **only on GET `/streams/*` and
  `/shapes/*`**. On `/api/*`, `/registry/*`, or any non-GET method it is not
  even considered — it falls through to the API-key path and fails. **Writes
  never bypass the developer** (D6).
- **Composition / precedence.** A request is authorized if **either** a valid
  API key **or** a valid read token authorizes it. The two are told apart by
  **shape** — a three-segment `a.b.c` bearer token on a GET read route is
  verified as a JWT; anything else (`tsp_…` keys, or JWT-shaped tokens on
  non-read routes) takes the API-key path unchanged. So neither verifier runs
  twice and server-side callers are wholly unaffected.
- **`pfx` claim.** The token's `pfx` must be a **prefix of the requested
  gateway path** (`path.startsWith(pfx)`, tenant segment included). Wrong
  prefix → **403**.
- **`exp` + clock-skew leeway.** `exp` is verified with a
  `GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS` (default **60 s**) leeway so a token
  that just tipped over against a slightly-off clock is not spuriously
  rejected mid-long-poll. Expired-beyond-leeway or otherwise-invalid →
  **401** with a body telling the client to **reconnect with a fresh token**
  (cheap: the stream is resumable — resume from your last offset).
- **Disabled by default.** With no `GATEWAY_JWT_SECRET`, the JWT path is off
  and only API keys are accepted.

### CORS (browser read routes only)

Browsers read `/streams/*` and `/shapes/*` cross-origin, so the gateway
answers the preflight and sets response CORS headers **for GET on those two
route families only** — never `/api/*` or `/registry/*`.

- **Preflight** (`OPTIONS`) is answered locally (204), before auth — a
  preflight carries no credentials, so requiring one would deadlock the read.
- **Response headers** ride every GET read, including 401/403 rejections, so a
  browser can *read the status* and react (reconnect on 401). Offset/cursor/
  etag headers are exposed (`Access-Control-Expose-Headers: *`).
- **Non-credentialed:** the token is a bearer header, not a cookie, so
  `Access-Control-Allow-Credentials` is never set — which lets the default
  `*` origin work. Set `GATEWAY_CORS_ALLOW_ORIGINS` to a comma-separated list
  to reflect only specific origins (an open policy is still safe: the JWT
  gates the actual read).

## Configuration (env)

`.env.example` is owned by T1.1 and not extended by this package; the
gateway reads everything from env with these defaults:

| Var                                   | Default                 | Meaning                                                                                                    |
| ------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PORT`                                | `8787`                  | Listen port.                                                                                               |
| `HOST`                                | `0.0.0.0`               | Listen host.                                                                                               |
| `TEASPILL_TENANT`                     | `default`               | Deployment tenant (addressing.md §1) used to expand `/a/<type>/<id>`.                                      |
| `RESTATE_INGRESS_URL`                 | `http://localhost:8080` | Compose sets `http://restate:8080`.                                                                        |
| `RESTATE_ADMIN_URL`                   | `http://localhost:9070` | Compose sets `http://restate:9070`.                                                                        |
| `ELECTRIC_URL`                        | `http://localhost:3000` | Compose sets `http://electric:3000`.                                                                       |
| `DURABLE_STREAMS_URL`                 | `http://localhost:4437` | Compose sets `http://durable-streams:4437`.                                                                |
| `DATABASE_URL`                        | —                       | Postgres for `api_keys`. Optional only if the bootstrap key is set.                                        |
| `GATEWAY_BOOTSTRAP_API_KEY`           | —                       | Dev-only literal API key (see Auth).                                                                       |
| `GATEWAY_MAX_BODY_BYTES`              | `1048576`               | 1 MiB body cap on commands & proxied writes (T1.2c; A4 journal budget). Oversize → 413 with a clear error. |
| `GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS` | `120000`                | Upstream first-byte timeout; must exceed durable-streams' 30 s long-poll park (R5).                        |
| `GATEWAY_JWT_SECRET`                  | —                       | HS256 shared secret enabling the optional JWT read path (T1.4). Unset ⇒ JWT path disabled, API keys only.  |
| `GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS` | `60`                    | Clock-skew leeway when verifying a read token's `exp`.                                                     |
| `GATEWAY_CORS_ALLOW_ORIGINS`          | `*`                     | Allowed CORS origins for GET `/streams/*` & `/shapes/*`. `*` or a comma-separated list.                    |
| `LOG_LEVEL`                           | `info`                  | pino level (structured request logging built in).                                                          |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | —                       | When set, spans export via OTLP/HTTP; otherwise the tracer is a no-op (exporter is env-gated).             |

## Registration networking (read this before registering a service)

Inherited stance from `docs/self-hosting-networking.md` §3: the `uri` you
POST to `/registry/deployments` is handed to Restate **as-is**, and Restate
**dials it directly** on every invocation — that traffic does not pass
through the gateway. The URI must therefore be reachable _from inside the
`restate` container_:

- compose-network service → `http://<service-name>:<port>`
- host-run service (local dev) → `http://host.docker.internal:<port>` —
  **never `http://localhost:<port>`** (registers fine, then every invocation
  fails: `localhost` inside the container is the container). The gateway
  deliberately performs **no URL rewriting** — electric agents' undocumented
  loopback rewrite is the failure mode this stance exists to prevent.

## Docker image

Compose builds with context `./packages/gateway`, which excludes the pnpm
workspace root — so the image consumes a prebuilt self-contained bundle:

```sh
pnpm --filter @teaspill/gateway bundle   # esbuild -> dist/docker/server.mjs
docker compose build gateway
```

The Dockerfile is two-stage: stage 1 smoke-runs the bundle's import graph
(`GATEWAY_SMOKE=1`), stage 2 is a minimal `node:22-slim` runtime (plus
`wget` for the compose healthcheck), running as the non-root `node` user.

## Design notes (T1.2 is an L task)

- **Framework: Fastify.** Streaming replies without buffering (R5's hard
  requirement), built-in body limits (the 1 MiB cap), pino structured
  logging, and no default transforms that would corrupt byte offsets. The
  proxy itself uses `undici` directly for byte-exact pass-through — see the
  header-by-header rules in `src/proxy.ts`.
- **R5 evidence:** `src/r5-streams.test.ts` kills a client mid-long-poll and
  resumes via offset _through_ the gateway (plus a gateway-restart-mid-read
  case). It always runs against a faithful in-memory fake of the pinned Rust
  server's contract (ported from `durable-streams-rust/src/handlers.rs`);
  set `TEASPILL_R5_REAL_DS_URL` to run the same suite against the real
  server (instructions in the test header).
- **Addressing:** the canonical derivation functions now live in
  `@teaspill/schema` (promoted from the gateway port in 0002:T1.1);
  `src/addressing.ts` is a thin re-export of the names the gateway consumers
  import by relative path (`./addressing.js`), so callers and tests are
  unchanged.
- **A3 enforced twice:** instance-id validation rejects the empty string at
  the route, and `ingressUrl()` refuses any empty Restate key + always
  percent-encodes keys in ingress paths.
- **Agent handler names** (`spawn`/`message` + the per-verb control handlers
  `interrupt`/`pause`/`resume`/`archive`) are a seam shared with T2.1 (same
  dispatch group) — the single authoritative public→internal map is
  `AGENT_HANDLERS` in `src/routes/api.ts` (0002:A1).
