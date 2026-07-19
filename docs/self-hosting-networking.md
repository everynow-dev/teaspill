# Self-hosting: compose networking stance

Written by T1.1 so T1.2 (gateway registry route) and T4.1 (executor host)
inherit a documented position instead of rediscovering it — this is the
same class of problem as electric agents' undocumented Docker webhook
loopback rewrite (work/plans/0001-build-v1/PLAN.md §1, one of the observed upstream bugs this
project exists to avoid repeating). Scope here is deliberately narrow: the
compose-network facts assertable from `docker-compose.yml` today, not a
full self-hosting guide (that's T9.2).

## 1. One compose network, service-name DNS

All five services (`postgres`, `restate`, `electric`, `durable-streams`,
`gateway`) sit on a single bridge network named `teaspill`. Any container
on that network resolves the others by service name at their
container-internal port:

| Service           | Internal address       |
| ----------------- | ---------------------- |
| postgres          | `postgres:5432`        |
| restate (ingress) | `restate:8080`         |
| restate (admin)   | `restate:9070`         |
| electric          | `electric:3000`        |
| durable-streams   | `durable-streams:4437` |
| gateway           | `gateway:8787`         |

**Rule:** service-to-service calls between containers on this network
always use the service name, never `localhost` and never the host-published
port. The gateway's `RESTATE_INGRESS_URL`, `RESTATE_ADMIN_URL`,
`ELECTRIC_URL`, `DURABLE_STREAMS_URL`, and `DATABASE_URL` env vars in
`docker-compose.yml` already follow this.

## 2. Host-published ports are a dev convenience, not the access path

Every service also publishes its port to the host (`${VAR:-default}:PORT`,
configurable via `.env`) so a developer can `psql`, `curl electric`, `curl
durable-streams`, or hit the Restate admin API directly from their laptop.

This is **not** the production access story. Per D6, the gateway is the
single entrypoint; internal services are not meant to be reached directly
by external clients. Treat the published ports on `postgres`, `restate`,
`electric`, and `durable-streams` as a localhost-only debugging surface —
don't build anything that depends on them being reachable from outside the
host running compose.

## 3. The loopback-class problem: Restate's admin API dials services directly

This is the one that bit electric agents (undocumented webhook loopback
rewriting) and needs an explicit stance here.

Restate's deployment model: an agent-loop or executor service registers
itself with Restate's **admin API** by giving Restate a URL. Restate then
**dials that URL directly** on every invocation — this traffic does not
go through the gateway, and it does not go through whatever service did
the registering. The URL you register is the URL Restate itself must be
able to reach, from _inside the `restate` container_.

Two cases:

**(a) The service is itself a compose service on the `teaspill` network.**
Register it with its compose service name and internal port (e.g.
`http://agent-loop:9080`). Restate reaches it via Docker's built-in DNS.
No special handling needed — this is the easy case and, longer-term, the
one production deployments should prefer.

**(b) The service runs on the host, outside this compose network** — the
common case during local dev before T6.2's CLI exists, and likely still
common after (fast iteration on an agent-loop service usually means running
it directly on the host, not rebuilding a container per change). This is
where the loopback trap lives:

- The service is _not_ reachable at `restate`'s view of `localhost` —
  `localhost` inside the `restate` container is the container's own
  network namespace, not the host's.
- `docker-compose.yml` adds `extra_hosts: ["host.docker.internal:host-gateway"]`
  to the `restate` service specifically to fix this on Linux. Docker
  Desktop (macOS/Windows) already resolves `host.docker.internal` to the
  host without any extra config; plain Docker Engine on Linux does not,
  which is what the `host-gateway` special value provides.
- **Stance: any service that registers with Restate from outside the
  compose network must register `http://host.docker.internal:<port>`,
  never `http://localhost:<port>`.** `http://localhost:<port>` will
  register successfully (the admin API doesn't validate reachability at
  registration time) and then fail silently/confusingly on the first
  invocation — the exact "undocumented loopback rewrite" failure mode this
  doc exists to prevent.
- T1.2's registry route (gateway forwarding registration calls to the
  Restate admin API) and T6.2's CLI defaults should default outgoing
  registration URLs to `host.docker.internal` whenever the target process
  isn't itself running inside the `teaspill` compose network, and let the
  developer override explicitly for case (a).

## 4. Same reasoning applies to T4.1's executor host

> Realized: the executor-host service and the overlay that networks it now
> ship in `@teaspill/reference-deployment` (0002:T4.1). Its
> [`docker-compose.overlay.yml`](../docker-compose.overlay.yml) puts both the
> agent-loop and executor onto the `teaspill` network (case (a) service-name
> URLs); the host-run recipe (case (b), `host.docker.internal`) is documented
> in that package's README.

The `workspace/<key>` virtual object delegates to an executor host service
(PLAN T4.1). If that host process runs outside the compose network, it hits
the identical problem as §3(b): Restate (or the workspace object's
`ctx.run` calls into the host) needs `host.docker.internal`, not
`localhost`, to call back out. If T4.2's Docker adapter uses a mounted
Docker socket to spin up sibling containers, those containers are peers of
whatever network the daemon's default is, not automatically members of
`teaspill` — attach them explicitly if they need to reach `postgres`,
`electric`, etc., or route everything through the gateway/durable-streams
published ports instead.

## 5. Known gap: `durable-streams` has no container-level healthcheck

`electricax/durable-streams-server-rust:0.1.4` is a distroless image — no
shell, no `curl`/`wget`, no CLI healthcheck subcommand (verified by pulling
the image and listing its filesystem: `/usr/local/bin/` contains only the
server binary itself). Docker's `HEALTHCHECK` always execs inside the
container, so there is nothing to exec. `docker-compose.yml` sets
`healthcheck: disable: true` for this service rather than faking one.

Consequence for anything that waits on it: `depends_on` conditions against
`durable-streams` can only use `condition: service_started` (container is
up), not `condition: service_healthy` (port is accepting connections and
serving). The gateway (T1.2) and the CLI (T6.2) should treat
connection-refused/retry-with-backoff against `durable-streams` as their
own application-level liveness signal, the same way T6.2's anticipation
note already plans for the "register-before-server-up" race against the
gateway itself.
