/**
 * `onWakeOnlyHarness()` (0002:T4.1) — a `HarnessSpec` for agents that handle
 * EVERY wake deterministically in their `onWake` hook and never run an LLM.
 *
 * 0001:A10's onWake contract makes deterministic (non-LLM) agents possible:
 * an `onWake` that returns `{ handled: true }` fully handles the wake and the
 * harness never runs. The conformance agents (0001:T6.3's documented
 * contract, shipped here) are exactly that. `defineAgent` still requires a
 * harness selection, so this spec provides one that:
 *
 *  - names the kind `native` for `run_started.payload.harness`/registration
 *    (the frozen schema's harness enum is `native | casdk`);
 *  - carries the developer's tools through unchanged (onWake-only agents
 *    normally have none);
 *  - supplies NO `buildHarness`, so the agent object falls back to the static
 *    `harness.run` path — which throws a LOUD, actionable error if a wake is
 *    ever handed off (an onWake that forgot to return `{ handled: true }`).
 *
 * Nothing here touches an LLM provider, an API key, or the network.
 */

import type { HarnessSelection, HarnessSpec } from "@teaspill/agents-sdk";
import type { AnyToolDefinition, Harness } from "@teaspill/harness-native";

export const ON_WAKE_ONLY_HANDOFF_ERROR =
  "onWakeOnlyHarness: this agent has no LLM harness — its onWake hook must handle every wake " +
  "(return { handled: true }). A wake was handed off to the harness instead; fix the onWake " +
  "handler (or select a real harness via native(...)/claudeAgentSdk(...)).";

export function onWakeOnlyHarness(): HarnessSpec {
  return {
    kind: "native",
    finalize(userTools: readonly AnyToolDefinition[]): HarnessSelection {
      const harness: Harness = {
        kind: "native",
        run() {
          throw new Error(ON_WAKE_ONLY_HANDOFF_ERROR);
        },
      };
      return { kind: "native", tools: [...userTools], harness };
    },
  };
}
