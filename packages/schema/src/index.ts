/**
 * @teaspill/schema — canonical timeline event schema (0001:T0.1) + token-delta
 * framing. STATUS: PROPOSED, not frozen — see src/events.ts header and
 * docs/casdk-mapping.md (freezes at gate 0001:G3).
 *
 * Entity addressing helpers (docs/addressing.md §9) land here via a follow-up
 * task; they are not part of 0001:T0.1.
 */

export * from "./events.js";
export * from "./deltas.js";
export * from "./snapshot-policy.js";
