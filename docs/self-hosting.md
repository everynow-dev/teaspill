# Self-hosting teaspill

teaspill self-hosts as a five-service Docker Compose stack plus your own
developer-deployed services (agent-loop and executor). The **gateway is the
single entrypoint** (D6): everything external — your services, UIs, the CLI —
talks to teaspill through the gateway, and the internal services
(restate / postgres / electric / durable-streams) are never exposed directly.

This guide covers the compose stack, environment configuration, the dev loop,
the networking assumptions, and backup/restore. For the networking rationale
in depth, see [self-hosting-networking.md](./self-hosting-networking.md).

---

## Deployment model

```
                       ┌─────────────────────────────────────────┐
   UIs / CLI /         │  compose stack (docker-compose.yml)      │
   your backend        │                                         │
        │              │   gateway ──► restate                   │
        │  API key /   │      │     ├─► postgres  ◄── electric    │
        └──────────────┼──►   │     └─► durable-streams           │
       (single         │      │                                  │
        entrypoint)    └──────┼──────────────────────────────────┘
                              │  Restate dials registered URLs directly
                              ▼
            ┌──────────────────────────────┐
            │ agent-loop service(s)         │  ← you deploy these
            │ executor host + workspaces    │     (register through the gateway)
            └──────────────────────────────┘
```

- The **compose stack** (below) is infrastructure: coordination core, catalog
  store, shape sync, history store, and the gateway.
- **Agent-loop services** (your `defineAgent` + `serve(...)` process, D4) and
  **executors** (workspace environments, D4) are **developer-deployed**. They
  register themselves with Restate **through the gateway's `/registry/*`
  route**, and Restate then dials them directly on every invocation.
- Two planes scale independently: agent-loop replicas scale on LLM
  concurrency; the executor fleet scales on workspace demand.

---

## The compose stack — five services

From [`docker-compose.yml`](../docker-compose.yml). All image tags are pinned
and were verified live on 2026-07-17 (see the compose file header and the T1.1
WORKLOG entry for the verification method):

| Service           | Image                                              | Role                                                                    |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `postgres`        | `postgres:17-alpine`                               | Catalog store (D1) + Electric's logical-replication source. Runs with `wal_level=logical`. |
| `restate`         | `restatedev/restate:1.7.2`                         | Coordination core (D2). Single-node dev/self-host mode.                 |
| `electric`        | `electricsql/electric:1.7.7`                       | Catalog sync to UIs via shapes (D1), fed by Postgres logical replication. |
| `durable-streams` | `electricax/durable-streams-server-rust:0.1.4`     | Authoritative history/telemetry store (D1), Rust server. `file-durable` (fsync'd) mode. |
| `gateway`         | built from `packages/gateway`                      | The single entrypoint (D6). All external traffic; proxies the internal services. |

### Ports

Every service also publishes its port to the host for local debugging (via
`.env`, see below). Container-internal ports are fixed:

| Service           | Host port (default) | Internal port(s)               |
| ----------------- | ------------------- | ------------------------------ |
| gateway           | `8787`              | `8787`                         |
| restate           | `8080` / `9070` / `9071` / `5122` | ingress `8080`, admin `9070`, metrics `9071`, node `5122` |
| postgres          | `5432`              | `5432`                         |
| electric          | `3000`              | `3000`                         |
| durable-streams   | `4437`              | `4437`                         |

> The host-published ports are a **localhost-only debugging surface**, not the
> production access path. Per D6, external clients reach teaspill only through
> the gateway. Don't build anything that depends on the internal ports being
> reachable from outside the host.

### Health & startup ordering

Every service except `durable-streams` ships a Docker healthcheck, and the
gateway `depends_on` them `condition: service_healthy`. `durable-streams` is a
**distroless image with no shell** — a container-exec healthcheck is
impossible, so its healthcheck is disabled and consumers treat
connection-refused/retry-with-backoff as the application-level liveness signal
([self-hosting-networking.md §5](./self-hosting-networking.md)). The gateway
therefore `depends_on: durable-streams: condition: service_started` only.

> The gateway service builds from `packages/gateway`. Building the image
> consumes a prebuilt self-contained bundle — run
> `pnpm --filter @teaspill/gateway bundle` before `docker compose build
> gateway`.

---

## Environment configuration

Copy [`.env.example`](../.env.example) to `.env` before running the stack:

```sh
cp .env.example .env
```

**Every variable has a working default baked into the compose file itself**
(`${VAR:-default}`), so an empty/missing `.env` still boots the stack. The
`.env` file only matters if you want non-default ports or credentials.

| Variable                | Default    | Meaning                                                                                     |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`         | `teaspill` | Catalog DB user (has REPLICATION, which Electric needs).                                     |
| `POSTGRES_PASSWORD`     | `teaspill` | **Change before ever exposing `POSTGRES_PORT` beyond localhost.**                            |
| `POSTGRES_DB`           | `teaspill` | Catalog database name.                                                                       |
| `POSTGRES_PORT`         | `5432`     | Host-side published port. Container-internal port is always 5432.                           |
| `RESTATE_INGRESS_PORT`  | `8080`     | Host-side Restate ingress (invocations in).                                                 |
| `RESTATE_ADMIN_PORT`    | `9070`     | Host-side Restate admin API (deployment registration).                                      |
| `RESTATE_METRICS_PORT`  | `9071`     | Host-side Prometheus metrics.                                                                |
| `RESTATE_NODE_PORT`     | `5122`     | Node-to-node (reserved; unused single-node).                                                 |
| `ELECTRIC_PORT_HOST`    | `3000`     | Host-side shape API port.                                                                    |
| `ELECTRIC_INSECURE`     | `true`     | **Dev-mode only.** Skips shape-API auth. Set `false` (and provide `ELECTRIC_SECRET`) before exposing Electric beyond localhost. |
| `DURABLE_STREAMS_PORT`  | `4437`     | Host-side durable-streams port.                                                             |
| `DURABLE_STREAMS_LOG`   | `info`     | Rust `RUST_LOG` filter (`error`/`warn`/`info`/`debug`/`trace`).                             |
| `GATEWAY_PORT`          | `8787`     | Host-side gateway port.                                                                      |

The gateway reads further env directly (defaults suit compose) — API-key /
JWT / CORS / timeout config. Those are covered in [auth.md](./auth.md) and the
[gateway README](../packages/gateway/README.md).

> `DATABASE_URL` is **not** in `.env.example`. Compose synthesizes it for
> in-network consumers (electric, gateway) from
> `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`. Anything run **outside**
> the compose network (a CLI, local tests) must set it explicitly, e.g.
> `postgresql://teaspill:teaspill@localhost:5432/teaspill?sslmode=disable`.

---

## Running the stack

### `make dev` — the minimal wrapper

[`Makefile`](../Makefile) is a thin, three-target wrapper around
`docker compose`:

```sh
make dev     # cp .env.example → .env if missing, then `docker compose up -d`
make down    # stop + remove containers (named volumes persist)
make logs    # follow logs for all services
make config  # validate & print the fully-resolved compose config
```

### `teaspill dev` — the richer CLI loop

The [`teaspill` CLI](../packages/cli/README.md) supersedes the Makefile once
you have agents to deploy. `teaspill dev` (alias `platform-dev`):

1. `docker compose up -d`,
2. **waits on gateway health**,
3. **registers your local deployment(s) with retry + exponential backoff**
   (avoiding the "register-before-up" race), then
4. tails logs. `--watch` re-registers when your build output changes.

```sh
teaspill dev --watch
```

Client config (flags override env): `--gateway` / `TEASPILL_GATEWAY_URL`
(default `http://localhost:8787`), `--api-key` / `TEASPILL_API_KEY`,
`--tenant` / `TEASPILL_TENANT` (default `default`), `--deployment` /
`TEASPILL_DEPLOYMENT_URL` (default `http://host.docker.internal:9080`).

---

## Networking assumptions (read before registering a service)

The full rationale is in
[self-hosting-networking.md](./self-hosting-networking.md). The one rule that
bites everyone:

> **When your agent-loop or executor runs on the host (outside the compose
> network), register it as `http://host.docker.internal:<port>` — never
> `http://localhost:<port>`.**

Restate dials the URL you register **directly, from inside the `restate`
container**, on every invocation — that traffic does not pass through the
gateway. `localhost` inside the container is the container itself, so a
`localhost` registration succeeds at registration time and then fails silently
on the first invocation. The gateway deliberately performs **no URL
rewriting** (electric agents' undocumented loopback rewrite is exactly the
failure mode this stance avoids).

- **Compose-network service** → register `http://<service-name>:<port>`.
- **Host-run service (local dev)** → register `http://host.docker.internal:<port>`.
  `docker-compose.yml` adds `extra_hosts: ["host.docker.internal:host-gateway"]`
  to the `restate` service so this works on plain Docker Engine (Linux) as well
  as Docker Desktop.

Registration flows through the gateway `/registry/*` route (allowlisted to
Restate's admin API). `serve({ registration })` from `@teaspill/agents-sdk`
posts it once; `teaspill dev` wraps that with health-wait + backoff.

### Executor & the Docker socket

The T4.2 Docker executor adapter grants workspace access by **mounting the
host Docker socket** into the executor container. This is **root-equivalent
access to the host** — a self-host / single-tenant dev convenience only. Keep
the executor an internal, developer-deployed service behind the gateway trust
boundary; never expose it to untrusted callers while it holds the socket. For
multi-tenant or hostile-code hosting, move to a boundary that doesn't hand out
host root (rootless DinD, a remote VM adapter). See the
[executor README](../packages/executor/README.md) for the full tradeoff.

**Prod hardening of the workspaces themselves** (this hardens the *containers*,
not the socket holder above):

- **Default image is digest-pinned.** The adapter's default workspace image is
  `alpine:3.20@sha256:…` (pinned to an immutable content digest, not the mutable
  tag) so every executor host materializes a byte-identical, supply-chain-
  verified base. Override per adapter or per workspace
  (`adapterOptions.image`) — pin your own images by digest too.
- **Network isolation is per-workspace.** `adapterOptions.network` accepts
  `none` (hard isolation — loopback only), `bridge` (the **default**: egress via
  the default bridge), or a custom user-defined network name. The default is
  `bridge` because agents routinely need egress for tool calls (package installs,
  HTTP APIs); set `none` when running untrusted code that must not reach the
  network, or a custom network name to join an operator-defined network.

Neither of these makes the socket-mounted executor safe to expose to untrusted
callers — they harden the workspaces, not the host boundary above.

---

## Backup & restore

The backup/restore procedure and scripts (pg_dump, streams data-dir snapshot,
Restate snapshot config, and which store combinations restore cleanly) are
documented in **[backup-restore.md](./backup-restore.md)** (owned by T8.3; it
may be authored in parallel with this guide).

The key correctness fact to keep in mind (D1/D7): the three stores hold
different truths. The catalog + streams restore the **archived** entities
cleanly; restoring catalog+streams **without** Restate loses **active**
entities' in-flight working set (Restate holds the working set only; it is not
the archive). See [backup-restore.md](./backup-restore.md) for the supported
combinations.

Persistent state lives in named Docker volumes: `postgres_data`,
`restate_data`, `durable_streams_data`, `electric_storage`. `make down` /
`docker compose down` preserve them; `docker compose down -v` destroys them.
