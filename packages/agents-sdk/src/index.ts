/**
 * @teaspill/agents-sdk — placeholder entry point.
 *
 * Scaffolded by T0.3; real implementation lands in the phase task(s) that
 * own this package (see PLAN.md §5). This module exists so the package
 * builds, typechecks, and has a passing test from day one.
 */

export const packageName = "@teaspill/agents-sdk" as const;

// T1.4 — optional JWT read path: developers mint short-lived read tokens so
// browsers can read /streams/* and /shapes/* directly (D6). See read-token.ts.
export {
  mintReadToken,
  type MintReadTokenOptions,
  type ReadTokenClaims,
} from "./read-token.js";
