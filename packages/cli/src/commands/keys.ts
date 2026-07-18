/**
 * `teaspill keys create | revoke | ls` — API-key admin (0002:T5.1).
 *
 * ## Why this is a DB command, not a gateway route
 *
 * Key minting is an OPERATOR action, so it runs against the catalog Postgres
 * directly (via `@teaspill/catalog`), NOT through the gateway `/api/*`. The
 * gateway has no admin-auth tier — every route is authenticated by an API key
 * that is all-or-nothing (0001:D6) — so there is no privileged caller a "mint a
 * key" route could trust, and adding an admin tier is out of scope (0002:T5.1).
 * The operator who can reach the database is, by definition, already trusted.
 *
 * Connection: this is the one CLI command that needs a DB URL rather than the
 * gateway URL. It resolves `--database-url` then `DATABASE_URL` and builds a
 * short-lived catalog client through `deps.createKeysStore` (injected, so tests
 * run with a fake and no live Postgres).
 *
 * ## Security
 *
 * The plaintext `tsp_…` token is minted in memory, printed to stdout exactly
 * ONCE by `create`, and never persisted or logged — Postgres stores only its
 * sha256 hash. `ls` and `revoke` never emit token material. Revocation is a soft
 * delete (`revoked_at`); the gateway rejects any revoked row.
 */

import type { CliDeps, KeysStore } from "../deps.js";

export type KeysAction = "create" | "revoke" | "ls" | "list";

export interface KeysFlags {
  databaseUrl?: string;
  label?: string;
  json?: boolean;
}

function resolveDatabaseUrl(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const url = flag ?? env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "keys admin needs a database connection: pass --database-url or set DATABASE_URL " +
        "(operator context — this command talks to Postgres directly, not the gateway). " +
        "e.g. postgresql://teaspill:teaspill@localhost:5432/teaspill?sslmode=disable",
    );
  }
  return url;
}

function fmtTs(d: Date): string {
  return d.toISOString();
}

export async function runKeys(
  deps: CliDeps,
  action: string,
  selector: string | undefined,
  flags: KeysFlags = {},
): Promise<void> {
  const databaseUrl = resolveDatabaseUrl(flags.databaseUrl);
  const store = deps.createKeysStore(databaseUrl);
  try {
    switch (action) {
      case "create":
        await keysCreate(deps, store, flags);
        return;
      case "revoke":
        await keysRevoke(deps, store, selector, flags);
        return;
      case "ls":
      case "list":
        await keysLs(deps, store, flags);
        return;
      default:
        throw new Error(
          `unknown keys subcommand ${JSON.stringify(action)} — expected create | revoke | ls`,
        );
    }
  } finally {
    await store.close();
  }
}

async function keysCreate(deps: CliDeps, store: KeysStore, flags: KeysFlags): Promise<void> {
  const created = await store.create(flags.label !== undefined ? { label: flags.label } : {});
  if (flags.json === true) {
    // The token appears here once; the operator captures it now or never.
    deps.io.out(
      JSON.stringify(
        {
          id: created.id,
          token: created.token,
          label: created.label,
          createdAt: fmtTs(created.createdAt),
        },
        null,
        2,
      ),
    );
    return;
  }
  deps.io.out(`Created API key ${created.id}`);
  if (created.label !== null) deps.io.out(`  label: ${created.label}`);
  deps.io.out(`  token: ${created.token}`);
  deps.io.out("");
  deps.io.out("Store this token now — it is shown ONCE and cannot be recovered.");
  deps.io.out("(Postgres holds only its sha256 hash; the plaintext is never persisted.)");
}

async function keysRevoke(
  deps: CliDeps,
  store: KeysStore,
  selector: string | undefined,
  flags: KeysFlags,
): Promise<void> {
  if (selector === undefined || selector.trim() === "") {
    throw new Error(
      "keys revoke needs an identifier: a full key id (uuid), a key-id prefix, or the tsp_ token",
    );
  }
  const { row, alreadyRevoked } = await store.revoke(selector);
  if (flags.json === true) {
    deps.io.out(
      JSON.stringify(
        {
          id: row.id,
          label: row.label,
          revokedAt: row.revokedAt !== null ? fmtTs(row.revokedAt) : null,
          alreadyRevoked,
        },
        null,
        2,
      ),
    );
    return;
  }
  deps.io.out(
    alreadyRevoked
      ? `Key ${row.id} was already revoked (${row.revokedAt !== null ? fmtTs(row.revokedAt) : "?"})`
      : `Revoked key ${row.id}`,
  );
}

async function keysLs(deps: CliDeps, store: KeysStore, flags: KeysFlags): Promise<void> {
  const rows = await store.list();
  if (flags.json === true) {
    deps.io.out(
      JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          label: r.label,
          createdAt: fmtTs(r.createdAt),
          revokedAt: r.revokedAt !== null ? fmtTs(r.revokedAt) : null,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (rows.length === 0) {
    deps.io.out("(no api keys)");
    return;
  }
  for (const r of rows) {
    const status = r.revokedAt !== null ? `revoked ${fmtTs(r.revokedAt)}` : "active";
    const label = r.label !== null ? r.label : "-";
    deps.io.out(`${r.id}  ${status.padEnd(30)} ${fmtTs(r.createdAt)}  ${label}`);
  }
}
