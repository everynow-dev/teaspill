# @teaspill/executor

The executor plane (D4, T4.1): `workspace/<key>` Restate virtual objects
fronting real execution environments, delegated to an **executor host**
service behind a minimal **adapter** seam. T4.2 adds the `docker` and
hardened `local-unrestricted` adapters behind the same seam; this package
ships the object, the host, the containment module, and a dev-only `local`
adapter.

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
        │  ExecutorAdapter seam                (src/adapter.ts — T4.2's contract)
        ▼
      WorkspaceEnv (local | docker | …)        (src/local-adapter.ts)
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

### What T4.2 implements

`ExecutorAdapter` + `WorkspaceEnv` + `ExecHandle` in `src/adapter.ts` —
`ensure` (create-or-reattach, identity from key+config alone), `startExec`
(non-blocking handle with `onChunk` streaming + tailed completion), the six
FS ops, `dispose({ wipe })`. Register the adapter in the host's `adapters`
map; everything above the seam is untouched. The bundled `local` adapter is
**dev-only** (real host processes, no isolation beyond path containment —
it exists to test the flow honestly; it logs a loud warning unless `quiet`).

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
- **`docker` + `local-unrestricted` adapters, idle teardown** → T4.2.
- **Agent tool bindings (`bash`, `read_file`, …), auto-ensure** → T4.3.
- **Real durable-streams sink**: the `WorkspaceStreamSink` seam ships with
  in-memory/noop implementations only — the durable-streams client dep (and
  its version, pinned to server `0.1.4`'s protocol) is T2.2's pick; platform
  wiring plugs it in once reconciled.
