/**
 * @teaspill/schema — canonical timeline event schema (T0.1) + token-delta
 * framing. STATUS: PROPOSED, not frozen — see src/events.ts header and
 * docs/casdk-mapping.md (freezes at gate G3).
 *
 * Entity addressing helpers (docs/addressing.md §9) land here via a follow-up
 * task; they are not part of T0.1.
 */

export * from "./events.js";
export * from "./deltas.js";
