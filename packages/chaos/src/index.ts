/**
 * @teaspill/chaos — the failure-injection suite (0001:T9.1).
 *
 * The ACCEPTANCE TEST for 0001:D2/0001:D3. For each of 5 faults it (a) drives a
 * conformance scenario against a stack, (b) injects the fault mid-flight
 * (`docker compose kill/stop/up` or a process handle — the fault driver), then
 * (c) re-asserts the mapped 0001:D2/0001:D3 INVARIANT using the conformance kit's pure
 * `assert*` fns / scenario `check`s — "assert the invariant, not just no-crash".
 *
 * This package BUILDS ON `@teaspill/conformance`: it imports the `SCENARIOS`
 * registry, the reusable invariant checks, the live driver, and the offline
 * fakes (the fake durable-streams server, the manual exec adapter, the memory
 * world), and layers fault injection on top. See README.md for the fault↔
 * invariant table and how to run offline (CI) vs live (`TEASPILL_CHAOS=1`).
 *
 * Live chaos suites are gated on BOTH `TEASPILL_CHAOS` and `TEASPILL_STACK_URL`
 * and skip cleanly in CI; the offline invariant tests always run.
 */

export const packageName = "@teaspill/chaos" as const;

// The fault registry: metadata + the 0001:D2/0001:D3 invariant each fault asserts.
export * from "./faults.js";

// Env-gating for the live chaos suites (layers on conformance's stack gate).
export * from "./env.js";

// The fault-driver mechanism: shell out to `docker compose` kill/stop/up.
export * from "./docker-faults.js";

// Offline event fixtures (staged through the real outbox).
export * from "./fixtures.js";
