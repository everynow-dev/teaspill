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
| `POST /api/a/:type/:id/control` | `{ verb: interrupt\|pause\|resume\|archive, reason? }` → `agent.<type>/<id>/control/send` (T2.5 verbs; D8 dropped POSIX signals).                                                                                                                                                         |
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
- **Addressing:** `src/addressing.ts` is a verbatim port of the subset of
  docs/addressing.md §9 the gateway needs. Those functions belong in
  `@teaspill/schema`; when a follow-up task adds them there, delete the port
  and import instead (signatures intentionally identical).
- **A3 enforced twice:** instance-id validation rejects the empty string at
  the route, and `ingressUrl()` refuses any empty Restate key + always
  percent-encodes keys in ingress paths.
- **Agent handler names** (`spawn`/`message`/`control`) are a seam shared
  with T2.1 (same dispatch group) — single map in `src/routes/api.ts`.
