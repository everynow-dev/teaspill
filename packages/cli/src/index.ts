#!/usr/bin/env node
/**
 * @teaspill/cli — placeholder entry point for the `teaspill` binary.
 *
 * Scaffolded by T0.3; the real dev-loop/inspection commands land in T6.2.
 * `run()` is exported (not just executed as a side effect) so it can be
 * unit-tested without spawning a process.
 */

export const packageName = "@teaspill/cli" as const;

export function run(argv: readonly string[] = process.argv.slice(2)): string {
  const command = argv[0] ?? "help";
  return `teaspill: '${command}' is not implemented yet (see PLAN.md T6.2)`;
}

// Only execute when run as a script (the `teaspill` bin), not on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(run());
}
