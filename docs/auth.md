# Auth

teaspill has two auth paths at the gateway (the single entrypoint, D6):

1. **API keys** — server-side auth for every route. This is the primary path.
2. **An optional HS256 JWT read path** — a fast-follow that lets browsers read
   `/streams/*` and `/shapes/*` directly with a short-lived token, without the
   developer proxying every read.

There is **no permissions/scoping model at the platform layer**. The developer
proxies and implements their own authorization. **Writes never bypass the
developer** (D6): the read token is honoured on GET reads only.

Sources: [gateway README](../packages/gateway/README.md) (T1.2/T1.4),
`packages/gateway/src/{auth,jwt}.ts`,
`packages/agents-sdk/src/read-token.ts`.

---

## API keys

Every gateway route **except `GET /health`** requires
`Authorization: Bearer <key>`.

- Keys are 256-bit random values minted by `newApiKey()` (they look like
  `tsp_…`). Postgres stores the **sha256 hex digest** in `api_keys.hash`
  (`@teaspill/catalog`); lookup is by digest, comparison is constant-time, and
  a row with `revoked_at IS NOT NULL` is rejected.
- **Why sha256, not bcrypt/argon2:** those exist to slow brute-force of
  low-entropy passwords and are salted (which breaks indexed lookup). For a
  high-entropy random key, a fast digest is the standard choice and matches the
  frozen T1.3 catalog schema.

### Minting a key

The `teaspill keys` CLI is the ergonomic path (0002:T5.1):

```sh
# Needs a DB connection (operator context) — see below.
export DATABASE_URL='postgresql://teaspill:teaspill@localhost:5432/teaspill?sslmode=disable'

teaspill keys create --label my-service   # prints the tsp_ token ONCE
teaspill keys ls                          # id, label, created_at, revoked_at (never the token)
teaspill keys revoke <id | id-prefix | tsp_token>
```

`create` mints a 256-bit random `tsp_…` token, stores only its **sha256 hash**
in `api_keys.hash` via `@teaspill/catalog`, and prints the plaintext exactly
once — it is never persisted or logged and is not recoverable. `revoke` sets
`revoked_at` (a soft delete the gateway already rejects on); it accepts a full
key id (uuid), a key-id **prefix**, or the plaintext token (matched by hash) —
note the row stores no prefix of the key itself, so there is no "key-prefix"
selector. `--json` on any subcommand emits machine-readable output.

**Why a DB command, not a gateway route:** key minting is an operator action
and runs against the catalog Postgres directly. The gateway has **no admin-auth
tier** — every route is authenticated by an all-or-nothing API key (D6) — so
there is no privileged caller a mint route could trust, and adding an admin tier
is out of scope. The operator who can reach the database is already trusted.

The same primitives are available programmatically:

```ts
import { createApiKey } from "@teaspill/catalog"; // mints + stores the hash
// or the low-level pair, matching the gateway's verifier byte-for-byte:
import { newApiKey, hashApiKey } from "@teaspill/catalog";
```

(`@teaspill/gateway` also re-exports `newApiKey`/`hashApiKey` for its own tests;
catalog is the canonical home now that it owns the `api_keys` table.)

### Bootstrap key (dev only)

`GATEWAY_BOOTSTRAP_API_KEY` is a literal key accepted **without** a database
row, so a fresh stack is usable before any key exists. Dev only.

---

## The optional JWT read path (T1.4)

When `GATEWAY_JWT_SECRET` is set, a **browser** can read `/streams/*` and
`/shapes/*` directly with a short-lived HS256 token instead of an API key —
preserving the caching/resumability of the chattiest traffic without the
developer proxying every read. **With no secret set, this path is off and only
API keys are accepted.**

### Minting a read token

Developers mint tokens server-side with `@teaspill/agents-sdk`:

```ts
import { mintReadToken } from "@teaspill/agents-sdk";

const jwt = await mintReadToken({
  // one entity prefix covers both /timeline and /deltas (casdk-mapping §8.5)
  pfx: "/streams/t/default/agents/researcher/x1/",
  ttlSeconds: 300, // keep it SHORT — reconnecting is cheap
  secret: process.env.GATEWAY_JWT_SECRET!,
});
// hand `jwt` to the browser; it sends `Authorization: Bearer <jwt>`
```

`mintReadToken` signs `{ pfx, iat, exp }` with HS256 and throws unless `pfx`
is rooted at `/streams/` or `/shapes/`, `ttlSeconds` is a positive integer, and
`secret` is non-empty. Keep the secret server-side; never ship it to a browser.

### The `pfx` claim

`pfx` is a single path-prefix string. The gateway authorizes a request **iff
the requested gateway path starts with `pfx`** (tenant segment included).

Mint the prefix with a **trailing slash** for a clean boundary:
`/streams/t/default/agents/researcher/x1/` matches that entity's streams but
**not** a sibling `/streams/t/default/agents/researcher/x1extra/…`. Without the
slash the prefix leaks across neighbours. Because a browser's timeline read and
its delta read live under the same entity prefix, one token covers both
`/timeline` and `/deltas`.

### Rules (enforced in `app.ts`, verified in `src/jwt.ts`)

- **Reads only.** A read token is honoured **only on GET `/streams/*` and
  `/shapes/*`**. On `/api/*`, `/registry/*`, or any non-GET method it is not
  even considered — it falls through to the API-key path and fails. **Writes
  never bypass the developer** (D6): a read token can never spawn/send/control
  an agent.
- **Composition / precedence.** A request is authorized if **either** a valid
  API key **or** a valid read token authorizes it. The two are told apart by
  **shape**: a three-segment `a.b.c` bearer token on a GET read route is
  verified as a JWT; anything else (`tsp_…` keys, or JWT-shaped tokens on
  non-read routes) takes the API-key path unchanged. Server-side callers are
  wholly unaffected.
- **Wrong prefix → 403.** The `pfx` must be a prefix of the requested path.
- **`exp` + clock-skew leeway.** `exp` is verified with a
  `GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS` (default **60 s**) leeway, so a token
  that just tipped over against a slightly-off clock is not spuriously rejected
  mid-long-poll. Expired-beyond-leeway or otherwise-invalid → **401** with a
  body telling the client to **reconnect with a fresh token** (cheap: the
  stream is resumable — resume from your last offset).

### CORS (browser read routes only)

Browsers read `/streams/*` and `/shapes/*` cross-origin, so the gateway
answers preflight and sets response CORS headers **for GET on those two route
families only** — never `/api/*` or `/registry/*`.

- **Preflight** (`OPTIONS`) is answered locally (204), before auth — a
  preflight carries no credentials.
- **Response headers** ride every GET read, including 401/403 rejections, so a
  browser can read the status and react (reconnect on 401). Offset/cursor/etag
  headers are exposed (`Access-Control-Expose-Headers: *`).
- **Non-credentialed:** the token is a bearer header, not a cookie, so
  `Access-Control-Allow-Credentials` is never set — which lets the default `*`
  origin work. Set `GATEWAY_CORS_ALLOW_ORIGINS` to a comma-separated list to
  reflect only specific origins (an open policy is still safe: the JWT gates the
  actual read).

---

## Relevant gateway env

| Variable                              | Default | Meaning                                                                     |
| ------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                        | —       | Postgres for `api_keys`. Optional only if the bootstrap key is set.         |
| `GATEWAY_BOOTSTRAP_API_KEY`           | —       | Dev-only literal API key accepted without a DB row.                         |
| `GATEWAY_JWT_SECRET`                  | —       | HS256 shared secret enabling the JWT read path. Unset ⇒ path disabled.      |
| `GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS` | `60`    | Clock-skew leeway when verifying a read token's `exp`.                      |
| `GATEWAY_CORS_ALLOW_ORIGINS`          | `*`     | Allowed CORS origins for GET `/streams/*` & `/shapes/*`.                    |
