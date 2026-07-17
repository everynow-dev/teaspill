# @teaspill/executor

The executor plane (D4, T4.1/T4.2): `workspace/<key>` Restate virtual objects
fronting real execution environments, delegated to an **executor host**
service behind a minimal **adapter** seam. This package ships the object, the
host, the containment module, and three adapters behind that seam: the dev-only
`local` (T4.1), the guarded `local-unrestricted` (T4.2), and `docker` (T4.2 —
container per workspace, volume-backed, idle teardown). A small adapter
registry (`adapter-registry.ts`) selects among them by name.

## Design note (T4.1)

```
agent tool call (T4.3)
  └─► workspace/<key> virtual object          (src/workspace.ts)
        · Restate service `workspace`, key `<tenant>/<name>` (A3)
        · exclusive handlers ⇒ SERIALIZED per workspace (D4 single-writer)
        · explicitCancellation: true (A4 — mandatory)
        · K/V: { config, status, currentInvocationId, currentExec }
        │
        │  WorkspaceHostClient seam            (src/host-client.ts)
        │  · createRestateHostClient() — journaled ctx.genericCall
        │  · createDirectHostClient() — in-process, behind ctx.run
        ▼
      executor-host service                    (src/host.ts)
        · plain STATELESS Restate service (its own registered deployment,
          or co-located on the executor endpoint — src/endpoint.ts)
        · owns environments + running execs; lazily re-ensures after a
          restart (identity derives from workspaceKey + config alone)
        │
        │  ExecutorAdapter seam                (src/adapter.ts)
        ▼
      WorkspaceEnv                             (adapters, selected by name)
        · local              (src/local-adapter.ts — T4.1, dev-only)
        · local-unrestricted (src/local-unrestricted-adapter.ts — T4.2, gated)
        · docker             (src/docker-adapter.ts — T4.2)
          └─► DockerCli seam  (src/docker-cli.ts — shells out to `docker`)
```

### The long-exec protocol (D4/R4, SPIKE §d)

1. `exec` (exclusive) journals `currentExec`, creates a **durable awakeable**
   (id stable across retries), and dispatches `startExec` to the host with
   the awakeable id + a **per-exec stream path**
   (`/t/<tenant>/workspaces/<name>/exec/<execId>/stdout`). The host returns
   immediately.
2. The host runs the process via the adapter; stdout/stderr chunks go
   **out-of-band** to the durable stream through the `WorkspaceStreamSink`
   seam (best-effort telemetry — never through the journal, never read for
   control flow, D1/R4).
3. On completion the host resolves the awakeable
   (`POST /restate/awakeables/{id}/resolve`; late/double resolution is a
   safe no-op, SPIKE §d-3). The awaited result is
   `{ exitCode, tailBytes, streamRef, … }` with `tailBytes` budget-capped
   (default 8 KiB/channel, cap 128 KiB — journal entries stay ≪ 1 MiB, A4).
4. Dispatch is at-least-once (A4 §3) ⇒ the host **dedupes on
   `(workspaceKey, execId)`**; `execId` derives deterministically from the
   invocation id (or is caller-supplied for tool-level idempotency, T3.1).

### Hung-command safety (anticipate-a) — three layers

1. **Adapter hard timeout** (`timeoutMs`): kill-tree escalation
   (process-group SIGTERM → SIGKILL) on the host. Normal timeout path — the
   awakeable resolves with `timedOut: true`.
2. **Awakeable backstop** (`timeoutMs + awakeableGraceMs`): fires only when
   the host is dead/unreachable; the handler then issues a durable
   best-effort kill and returns `outcome: "timeout", timeoutKind:
"host-unresponsive"` instead of wedging the key.
3. **Shared `kill` escape hatch** (the workspace analogue of the agent
   object's shared `signal` seam): runs **concurrently** with the blocked
   exclusive `exec` — never queues behind it — reads the live `currentExec`
   K/V (SPIKE §a-2) and tells the host to kill the tree; the exec's
   awakeable then resolves with `killed: true` and the exec returns
   normally. `kill({ force: true })` additionally `ctx.cancel`s the
   in-flight invocation (for a suspected-dead host); thanks to
   `explicitCancellation` the handler still performs the durable host-kill
   cleanup before completing (A4). A shared `status` handler gives cheap
   concurrent reads.

### Path containment (anticipate-b)

One module, `src/path-containment.ts`, ported from electric
(`packages/agents-runtime/src/sandbox/{path-containment,unrestricted}.ts`):

- **String-level** (`containWorkspacePath` et al) for isolated adapters
  (docker/remote — T4.2): the container/VM root is the real boundary.
- **Realpath symlink-walk** (`resolveContainedPath`) for host-FS-sharing
  adapters (`local`): canonicalizes every component (and the root — the
  macOS `/var`→`/private/var` case) before checking, covering `../`,
  absolute-path, and symlink-component escapes, including targets that don't
  exist yet (write/mkdir).

Rules: **writes are contained on every adapter**; read containment is
declared per adapter (`ExecutorAdapter.readContainment`: `local` and
`docker` = `"workspace"`; a future `remote` may be `"environment"`).

### The adapter seam

`ExecutorAdapter` + `WorkspaceEnv` + `ExecHandle` in `src/adapter.ts` —
`ensure` (create-or-reattach, identity from key+config alone), `startExec`
(non-blocking handle with `onChunk` streaming + tailed completion), the six
FS ops, `dispose({ wipe })`. Adapters are registered in the host's `adapters`
map (built by `createAdapterRegistry`); everything above the seam is untouched
regardless of which adapter fronts a workspace — the minimal seam is what lets
E2B/Firecracker slot in later (D4).

### Adapters (T4.2)

- **`local`** (T4.1, dev-only): real host processes/FS, no isolation beyond
  path containment; logs a warning unless `quiet`. Kept for the flow tests.
- **`local-unrestricted`** (`src/local-unrestricted-adapter.ts`): the SAME host
  implementation, formalized for T4.2 with two deployment guards — a **loud
  startup banner** and a **required opt-in** (`{ allowUnrestricted: true }` or
  `TEASPILL_ALLOW_LOCAL_UNRESTRICTED=1`); construction THROWS otherwise, so it
  can never be selected by accident in a deployment. Still dev-only: containment
  guards against confused-deputy path bugs, not hostile code.
- **`docker`** (`src/docker-adapter.ts`): **one container per workspace**
  (`teaspill-<tenant>-<name>-<hash>`), a **named volume** mounted at `/work`
  (files persist across every exec in the workspace's life AND across container
  stop/remove — the volume outlives the container), and **idle teardown with a
  grace period**. A per-env activity counter arms an idle timer when the
  workspace goes quiet; if a new exec arrives during the grace the timer is
  cancelled and the still-warm container is reattached, otherwise the container
  is torn down (STOP when `persistent`, else REMOVE — volume preserved either
  way) and the next op reattaches (restart a stopped container or recreate a
  removed one against the same volume). The state machine runs under a per-env
  mutex so a reattach can't race an in-flight teardown (tactical pattern lifted
  from electric's `sandbox/docker.ts`, mapped onto the T4.1 host↔adapter seam:
  the host caches one env per key; the container comes and goes beneath it). Exec
  runs via `docker exec`, stdout/stderr stream out through the existing
  `onChunk` → `WorkspaceStreamSink` seam (chunked, out-of-band — the durable
  streams client stays deferred to platform wiring, as with T4.1). Kill /
  timeout map to an in-container marker-scan `kill -KILL` (fells only THIS
  exec's tree; `dispose` → `docker stop`/`rm`), wired to the T4.1 shared-`kill`
  seam identically to `local`. Read/write are contained to `/work` at the
  string level (the container is the isolation boundary; an in-container symlink
  escaping `/work` is not separately rejected — see `path-containment.ts`).

### Docker access & the socket-mount security tradeoff

Per T4.2 the compose dev env grants the executor Docker access by **mounting the
host Docker socket** (`/var/run/docker.sock`) into the executor container, NOT
by Docker-in-Docker (DinD). Socket-mount is chosen because it is dramatically
simpler (no privileged DinD daemon, no nested-storage/overlay pain, containers
are fast host-daemon siblings) and the `DockerCli` seam shells out to the
`docker` client that ships in the same image.

**The tradeoff, stated plainly: mounting the Docker socket is root-equivalent
access to the host.** Anything that can talk to the socket can start a container
that bind-mounts `/` and thereby read/modify any file on the host, escalate to
root, and see every other container. So:

- The socket mount is a **self-host / single-tenant dev convenience** (D6/D8:
  a tenant is a deployment). Do not expose the executor to untrusted callers
  while it holds the socket; the gateway (single entrypoint, API-keyed) is the
  trust boundary, and the executor is an internal, developer-deployed service.
- Workspace containers are hardened (`--cap-drop ALL`, `--security-opt
  no-new-privileges`, `--pids-limit`, memory/cpu caps, no swap) — but that
  hardens the *workspaces*, not the socket holder. The executor process itself
  must be treated as trusted-as-root.
- For multi-tenant or hostile-code hosting, move off socket-mount to a boundary
  that doesn't hand out host root: rootless DinD, a remote VM adapter
  (E2B/Firecracker — the reason the seam is kept minimal), or a per-tenant
  daemon. This is a documented standing constraint, mirrored in the code
  comment atop `src/docker-cli.ts`.
- Socket-mounted sibling containers are **not** on the `teaspill` compose
  network automatically (`docs/self-hosting-networking.md` §4) — attach them
  explicitly if they must reach `postgres`/`electric`/etc.

### Handler names

PLAN T4.1 writes the FS surface as `fs.{read,write,mkdir,rm,stat,ls}`; the
registered handler names are `fsRead`/`fsWrite`/`fsMkdir`/`fsRm`/`fsStat`/
`fsLs` — T2.0 verified the service-_name_ grammar but not handler names, so
we stay in the known-safe charset. Public spelling is the gateway's `/api/*`
name-map decision (T1.2 seam).

## Networking (anticipate-c)

This package inherits the stance in `docs/self-hosting-networking.md` — do
not re-solve it:

- The executor endpoint (workspace object and/or `executor-host`) is a
  **registered deployment**: Restate dials the registered URL directly, from
  inside the `restate` container. A host-run (non-compose) executor process
  MUST register `http://host.docker.internal:<port>`, never
  `http://localhost:<port>` (§3b there); a compose-service executor registers
  its service name (§3a).
- The host resolves awakeables through **Restate ingress as seen from the
  host process** (`createIngressAwakeableResolver({ ingressUrl })`): a
  host-run process uses the compose-published `http://localhost:8080`; a
  compose-service host uses `http://restate:8080`. Note the asymmetry with
  the registration URL above — they are different directions of the same
  loopback-class problem (§3/§4 there).
- T4.2's docker adapter: socket-mounted sibling containers are NOT on the
  `teaspill` network automatically (§4 there).

## Not covered here (deferred, by design)

- **Live-Restate behaviors** → conformance kit T6.3 / failure injection
  T9.1: real awakeable resolution + survive-endpoint-restart (SPIKE §d-4),
  real `ctx.cancel` + `@experimental` `explicitCancellation` semantics,
  replay of a crashed dispatch step, per-handler inactivity/abort timeouts,
  kill-executor-mid-exec (awakeable-timeout invariant), registration
  networking.
- **Docker adapter live-Restate behaviors** → T6.3/T9.1: the docker adapter's
  own logic (lifecycle state machine, exec, FS, containment) is covered here —
  unit-tested against a fake `DockerCli` and, when a daemon is present,
  end-to-end against real containers (`src/docker-adapter.test.ts`, gated on
  `isDockerAvailable()` so daemon-less CI skips). What's deferred is the same
  live-Restate set as above (awakeable resolution through the server, real
  cancellation, kill-executor-mid-exec) exercised *through* the docker adapter.
- **Compose wiring of the socket mount** (executor service + `docker.sock`
  bind) → T1.1/T9.2 self-hosting; the adapter and its `DockerCli` seam are here.
- **Agent tool bindings (`bash`, `read_file`, …), auto-ensure** → T4.3.
- **Real durable-streams sink**: the `WorkspaceStreamSink` seam ships with
  in-memory/noop implementations only — the durable-streams client dep (and
  its version, pinned to server `0.1.4`'s protocol) is T2.2's pick; platform
  wiring plugs it in once reconciled.
