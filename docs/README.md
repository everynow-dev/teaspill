# teaspill documentation

teaspill is a platform for durable AI agents: they run, spawn sub-agents,
communicate, share context, and stream their activity to UIs — coordinated on
Restate, with history projected to browser-readable durable streams and a
Postgres+Electric catalog. The gateway is the single entrypoint.

New here? Start with **[Differences from electric agents](./differences-from-electric-agents.md)**
for the positioning and architecture, then **[Self-hosting](./self-hosting.md)**
to run the stack. For a running end-to-end deployment (agent-loop + executor +
compose overlay), copy the **[reference deployment](../packages/reference-deployment/README.md)**
— the getting-started example.

## Guides

| Doc                                                              | What it covers                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Differences from electric agents](./differences-from-electric-agents.md) | Positioning: what teaspill keeps, changes, and drops, and why.                          |
| [Self-hosting](./self-hosting.md)                               | The 5-service compose stack, the reference-deployment overlay (agent-loop + executor), env config, `teaspill dev` / `make dev`, networking, backup pointer. |
| [Auth](./auth.md)                                               | API keys at the gateway (incl. the `teaspill keys create\|revoke\|ls` CLI) + the optional HS256 JWT read path. |
| [Agents SDK](./agents-sdk.md)                                   | `@teaspill/agents-sdk`: `defineAgent`, harness selection, platform/workspace tools, `onWake`, `serve`, state revisions. |
| [Frontend SDK](./frontend-sdk.md)                               | `@teaspill/frontend-sdk`: timeline materialization, the reducer, catalog shapes, the actions client, React. |
| [Schema reference](./schema-reference.md)                       | The frozen v1 canonical event vocabulary + token deltas.                                          |
| [Backup & restore](./backup-restore.md)                         | pg_dump, streams snapshot, Restate snapshot config, and which store combinations restore cleanly (authored by T8.3). |

## Reference (design docs)

| Doc                                                     | What it covers                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Addressing](./addressing.md)                           | The naming model: entity URLs, stream paths, workspace keys, Restate object names.     |
| [Streams](./streams.md)                                 | Stream layout, snapshot cadence, retention.                                            |
| [CASDK mapping](./casdk-mapping.md)                     | Claude Agent SDK records ↔ canonical events (the schema-freeze artifact).              |
| [Self-hosting networking](./self-hosting-networking.md) | The container↔host networking stance (the `host.docker.internal` rule).                |

## Design decisions

The authoritative behavior ledger is [`../work/plans/0001-build-v1/DECISIONS.md`](../work/plans/0001-build-v1/DECISIONS.md)
(decisions D1–D8 + amendments A1–A10). Each package README carries an
implementation design note for that package.
