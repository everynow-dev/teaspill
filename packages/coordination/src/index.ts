/**
 * @teaspill/coordination — Restate coordination services.
 *
 * Scaffolded by 0001:T0.3 as a placeholder; 0001:T2.4 drops in the first real
 * service (`cron/<key>`, src/cron.ts). Other services (agent object 0001:T2.1,
 * projection outbox 0001:T2.2, messaging 0001:T2.3, control API 0001:T2.5,
 * steerbox 0001:T2.6) land here via their own tasks — each in its own file, so
 * parallel tasks in this package stay disjoint (see work/plans/0001-build-v1/PLAN.md §5, 0001:T2.4 dispatch note).
 */

export const packageName = "@teaspill/coordination" as const;

export * from "./cron.js";
export * from "./agent-runtime.js";
export * from "./agent-seams.js";
export * from "./agent.js";
export * from "./archive-snapshot.js";
export * from "./control.js";
export * from "./messaging.js";
export * from "./steer.js";
export * from "./endpoint.js";
export * from "./projection-outbox.js";
export * from "./projection-catalog.js";
export * from "./reconciler.js";
export * from "./otel.js";
