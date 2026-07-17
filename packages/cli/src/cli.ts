/**
 * Arg parsing + subcommand dispatch for the `teaspill` binary (T6.2).
 *
 * ## Arg parser: `cac`
 *
 * `cac` (6.7.14) is a ~tiny, zero-dependency, ESM-friendly command parser that
 * generates `--help`/`--version` and per-command help for free. It is the same
 * parser vite/vitest use, so it is well-proven against this repo's Node/ESM
 * setup. We keep the parser at the EDGE only: every command body lives in
 * `commands/*` as a plain function that takes an injected `CliDeps`, so parse
 * and dispatch are unit-tested against fakes with no live stack (see the
 * per-command tests). `cac` never touches I/O directly — output goes through
 * `deps.io`.
 */

import { cac, type CAC } from "cac";
import { createDefaultDeps, type CliDeps } from "./deps.js";
import { resolveConfig, type CliGlobalFlags } from "./config.js";
import { agentsLs, spawnAgent, sendMessage, controlAgent } from "./commands/agents.js";
import { followLogs } from "./commands/logs.js";
import { runDev } from "./commands/dev.js";

const HELP_EPILOG = `
Config (flags override env):
  --gateway <url>      gateway base URL      env TEASPILL_GATEWAY_URL (default http://localhost:8787)
  --api-key <key>      gateway API key       env TEASPILL_API_KEY
  --tenant <tenant>    deployment tenant     env TEASPILL_TENANT (default default)

Examples:
  teaspill dev --watch
  teaspill agents ls --type researcher
  teaspill spawn researcher '{"topic":"otters"}'
  teaspill send /a/researcher/r1 '{"say":"hello"}'
  teaspill control /a/researcher/r1 interrupt --reason "stop"
  teaspill logs /a/researcher/r1
`;

interface GlobalOptions extends CliGlobalFlags {
  [key: string]: unknown;
}

/** Build the cac app. `deps` is injected for tests; defaults to real clients. */
export function buildCli(deps: CliDeps = createDefaultDeps()): CAC {
  const cli = cac("teaspill");

  cli.option("--gateway <url>", "Gateway base URL (env TEASPILL_GATEWAY_URL)");
  cli.option("--api-key <key>", "Gateway API key (env TEASPILL_API_KEY)");
  cli.option("--tenant <tenant>", "Deployment tenant (env TEASPILL_TENANT)");

  const config = (opts: GlobalOptions) =>
    resolveConfig({
      ...(typeof opts.gateway === "string" ? { gateway: opts.gateway } : {}),
      ...(typeof opts.apiKey === "string" ? { apiKey: opts.apiKey } : {}),
      ...(typeof opts.tenant === "string" ? { tenant: opts.tenant } : {}),
    });

  // -- dev ------------------------------------------------------------------
  cli
    .command("dev", "Bring up the stack, register local deployments, tail logs")
    .alias("platform-dev")
    .option("--deployment <url>", "Deployment URL to register (repeatable)")
    .option("--watch", "Re-register when the built output changes")
    .option("--watch-path <dir>", "Directory to watch (repeatable; default dist)")
    .option("--compose-file <path>", "Explicit docker-compose.yml path")
    .option("--no-compose", "Skip `docker compose up` (infra already running)")
    .option("--no-logs", "Skip tailing `docker compose logs -f`")
    .action(async (opts: GlobalOptions) => {
      await runDev(
        deps,
        config(opts),
        {
          deployment: asStringArray(opts.deployment),
          ...(opts.watch === true ? { watch: true } : {}),
          ...(opts.watchPath !== undefined ? { watchPath: asStringArray(opts.watchPath) } : {}),
          ...(typeof opts.composeFile === "string" ? { composeFile: opts.composeFile } : {}),
          // cac maps --no-compose/--no-logs to compose/logs === false.
          ...(opts.compose === false ? { noCompose: true } : {}),
          ...(opts.logs === false ? { noLogs: true } : {}),
        },
        installSigintSignal(),
      );
    });

  // -- agents ls ------------------------------------------------------------
  // cac has no multi-word command names, so `agents` takes an `<action>`
  // positional (`ls`/`list`) — `teaspill agents ls` dispatches here.
  cli
    .command("agents <action>", "Entity catalog — `agents ls`")
    .option("--type <type>", "Filter by agent type")
    .option("--status <status>", "Filter by status (active|idle|archived)")
    .option("--parent <url>", "Filter by parent entity url")
    .option("--json", "Emit raw JSON rows")
    .action(async (action: string, opts: GlobalOptions) => {
      if (action !== "ls" && action !== "list") {
        throw new Error(`unknown agents subcommand ${JSON.stringify(action)} — expected "ls"`);
      }
      await agentsLs(deps, config(opts), {
        ...(typeof opts.type === "string" ? { type: opts.type } : {}),
        ...(typeof opts.status === "string" ? { status: opts.status } : {}),
        ...(typeof opts.parent === "string" ? { parent: opts.parent } : {}),
        ...(typeof opts.tenant === "string" ? { tenant: opts.tenant } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });

  // -- spawn ----------------------------------------------------------------
  cli
    .command("spawn <type> [args]", "Spawn an entity (args = JSON or string)")
    .option("--id <id>", "Caller-supplied instance id (idempotent spawn)")
    .option("--parent <url>", "Parent entity url")
    .option("--idempotency-key <key>", "Idempotency-Key for the ingress send")
    .action(async (type: string, args: string | undefined, opts: GlobalOptions) => {
      await spawnAgent(deps, config(opts), type, args, {
        ...(typeof opts.id === "string" ? { id: opts.id } : {}),
        ...(typeof opts.parent === "string" ? { parent: opts.parent } : {}),
        ...(typeof opts.idempotencyKey === "string" ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
    });

  // -- send -----------------------------------------------------------------
  cli
    .command("send <url> <message>", "Send a message wake (message = JSON or string)")
    .option("--idempotency-key <key>", "Idempotency-Key for the ingress send")
    .action(async (url: string, message: string, opts: GlobalOptions) => {
      await sendMessage(deps, config(opts), url, message, {
        ...(typeof opts.idempotencyKey === "string" ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
    });

  // -- control --------------------------------------------------------------
  cli
    .command("control <url> <verb>", "Control verb: interrupt | pause | resume | archive")
    .option("--reason <reason>", "Optional reason (interrupt)")
    .action(async (url: string, verb: string, opts: GlobalOptions) => {
      await controlAgent(deps, config(opts), url, verb, {
        ...(typeof opts.reason === "string" ? { reason: opts.reason } : {}),
      });
    });

  // -- logs -----------------------------------------------------------------
  cli
    .command("logs <url>", "Follow + render an entity's timeline stream")
    .option("--deltas", "Also subscribe to the live token-delta stream")
    .option("--from-snapshot <seq>", "Fast-join from a state_snapshot seq")
    .action(async (url: string, opts: GlobalOptions) => {
      await followLogs(
        deps,
        config(opts),
        url,
        {
          ...(opts.deltas === true ? { deltas: true } : {}),
          ...(opts.fromSnapshot !== undefined ? { fromSnapshot: Number(opts.fromSnapshot) } : {}),
        },
        installSigintSignal(),
      );
    });

  cli.help((sections) => {
    sections.push({ body: HELP_EPILOG.trim() });
  });
  cli.version("0.1.0");
  return cli;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** Ctrl-C → an AbortSignal so `dev`/`logs` shut down cleanly. */
function installSigintSignal(): AbortSignal {
  const controller = new AbortController();
  const onSig = (): void => controller.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  return controller.signal;
}

/**
 * Parse argv and run. Returns the process exit code (0 ok, 1 on error) instead
 * of calling `process.exit`, so it is testable; the bin wrapper applies it.
 */
export async function run(
  argv: readonly string[] = process.argv.slice(2),
  deps: CliDeps = createDefaultDeps(),
): Promise<number> {
  const cli = buildCli(deps);
  try {
    // cac parses eagerly; run: false lets us await the async action below.
    const parsed = cli.parse(["node", "teaspill", ...argv], { run: false });
    if (parsed.options.help === true) {
      cli.outputHelp();
      return 0;
    }
    if (parsed.options.version === true) {
      cli.outputVersion();
      return 0;
    }
    if (argv.length === 0 || cli.matchedCommand === undefined) {
      cli.outputHelp();
      return argv.length === 0 ? 0 : 1;
    }
    await cli.runMatchedCommand();
    return 0;
  } catch (error) {
    deps.io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
