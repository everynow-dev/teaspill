/**
 * `local-unrestricted` adapter (0001:T4.2) — the FORMALIZED, deployment-guarded
 * profile of 0001:T4.1's dev-only `local` adapter (./local-adapter.ts).
 *
 * It is the SAME environment implementation (real host `sh` processes, real
 * host filesystem, containment via ./path-containment.ts — reused verbatim, not
 * reinvented). What 0001:T4.2 adds on top is the two things a production plane must
 * never trip over by accident:
 *
 *  1. **A LOUD startup warning.** Every construction logs a boxed banner (unless
 *     `quiet`, for tests) stating the adapter runs commands with NO isolation
 *     beyond path containment — full host network, host env, host FS reachable
 *     by any command it runs.
 *  2. **A REQUIRED opt-in.** Construction THROWS unless the operator explicitly
 *     acknowledges the danger — either `allowUnrestricted: true` in code OR the
 *     env gate `TEASPILL_ALLOW_LOCAL_UNRESTRICTED=1`. This is what stops the
 *     `docker`-vs-`local-unrestricted` selection (adapter-registry.ts) from
 *     silently falling back to host execution in a real deployment.
 *
 * Containment note (readContainment: "workspace"): identical to `local` — a
 * host-FS-sharing adapter, so reads/writes route through the realpath
 * symlink-walking containment (`resolveContainedPath`). Containment defends
 * against confused-deputy path bugs, NOT against hostile code: a command run
 * via exec can touch anything the host user can. That is exactly why it is
 * dev-only and gated.
 */

import type { EnsureParams, ExecutorAdapter, WorkspaceEnv } from "./adapter.js";
import { WorkspaceError } from "./errors.js";
import { createLocalAdapter } from "./local-adapter.js";

/** Env var that opts a deployment into host-unrestricted execution. */
export const LOCAL_UNRESTRICTED_ENV_GATE = "TEASPILL_ALLOW_LOCAL_UNRESTRICTED";

export interface LocalUnrestrictedAdapterOptions {
  /** Directory under which per-workspace roots are created (`<baseDir>/<tenant>/<name>`). */
  baseDir: string;
  /**
   * Explicit in-code opt-in. Either this or `TEASPILL_ALLOW_LOCAL_UNRESTRICTED=1`
   * is REQUIRED — construction throws otherwise (`WorkspaceError('policy')`).
   */
  allowUnrestricted?: boolean;
  /** Suppress the loud warning banner AND the opt-in requirement (tests only). */
  quiet?: boolean;
}

/**
 * Create the `local-unrestricted` adapter. DEV ONLY, guarded. Throws
 * `WorkspaceError('policy')` unless opted in (see options / env gate).
 * Environment identity derives from the workspace key alone, so a restarted
 * host reattaches to the same directory transparently (delegated to `local`).
 */
export function createLocalUnrestrictedAdapter(
  opts: LocalUnrestrictedAdapterOptions,
): ExecutorAdapter {
  const optedIn =
    opts.allowUnrestricted === true || process.env[LOCAL_UNRESTRICTED_ENV_GATE] === "1";

  if (!opts.quiet && !optedIn) {
    throw new WorkspaceError(
      "policy",
      "`local-unrestricted` adapter refused: it runs commands directly on the " +
        "host with NO isolation and must never be enabled by accident. Opt in " +
        `explicitly with { allowUnrestricted: true } or set ${LOCAL_UNRESTRICTED_ENV_GATE}=1. ` +
        "Use the `docker` adapter for anything beyond local development.",
    );
  }

  if (!opts.quiet) {
    console.warn(
      "\n" +
        "┌──────────────────────────────────────────────────────────────────┐\n" +
        "│  ⚠  teaspill: `local-unrestricted` executor adapter is ACTIVE      │\n" +
        "│                                                                    │\n" +
        "│  Commands run DIRECTLY ON THE HOST with no isolation beyond path   │\n" +
        "│  containment — full host network, host env, and host filesystem    │\n" +
        "│  are reachable by anything it executes. DEV ONLY. Never point a    │\n" +
        "│  deployment at this adapter; use `docker` instead.                 │\n" +
        "└──────────────────────────────────────────────────────────────────┘\n",
    );
  }

  // Same environment implementation as `local` (reused, not reinvented); the
  // inner adapter is kept quiet since the banner above is the loud one.
  const inner = createLocalAdapter({ baseDir: opts.baseDir, quiet: true });

  return {
    name: "local-unrestricted",
    readContainment: "workspace",
    ensure: (params: EnsureParams): Promise<WorkspaceEnv> => inner.ensure(params),
  };
}
