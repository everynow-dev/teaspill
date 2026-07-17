/**
 * @teaspill/coordination — Restate coordination services.
 *
 * Scaffolded by T0.3 as a placeholder; T2.4 drops in the first real
 * service (`cron/<key>`, src/cron.ts). Other services (agent object T2.1,
 * projection outbox T2.2, messaging T2.3, control API T2.5, steerbox T2.6)
 * land here via their own tasks — each in its own file, so parallel tasks
 * in this package stay disjoint (see PLAN.md §5 T2.4 dispatch note).
 */

export const packageName = "@teaspill/coordination" as const;

export * from "./cron.js";
export * from "./agent-runtime.js";
export * from "./agent-seams.js";
export * from "./agent.js";
export * from "./endpoint.js";
