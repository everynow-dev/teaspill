/**
 * @teaspill/schema — canonical timeline event schema (0001:T0.1) + token-delta
 * framing. STATUS: PROPOSED, not frozen — see src/events.ts header and
 * work/plans/0001-build-v1/notes/casdk-mapping.md (freezes at gate 0001:G3).
 *
 * Entity addressing helpers (https://teaspill.everynow.dev/reference/addressing) are additive module
 * surface (not event-schema), promoted here from gateway/frontend-sdk
 * duplicates by 0002:T1.1. See src/addressing.ts.
 */

export * from "./events.js";
export * from "./deltas.js";
export * from "./snapshot-policy.js";
export * from "./addressing.js";
