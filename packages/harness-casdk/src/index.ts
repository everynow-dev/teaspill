/**
 * @teaspill/harness-casdk — the Claude Agent SDK harness (0001:T7.1/0001:T7.2).
 *
 * Implements the frozen `Harness` interface (@teaspill/harness-native) via
 * 0001:D5's three durability layers:
 * - Effects: tool-seam.ts (0001:T7.2 plugs the real in-process MCP server in);
 * - Continuation: session-store.ts + the warm resume path (harness.ts);
 * - Truth: capture.ts (stream → canonical) + projection.ts (canonical →
 *   session, the cold-rebuild recovery path), both driven by the single
 *   per-version translation table (translation.ts, 0001:R3).
 */

export const packageName = "@teaspill/harness-casdk" as const;

export * from "./session-lines.js";
export * from "./id-map.js";
export * from "./sdk-client.js";
export * from "./translation.js";
export * from "./session-store.js";
export * from "./projection.js";
export * from "./delta-usage.js";
export * from "./capture.js";
export * from "./otel.js";
export * from "./tool-seam.js";
export * from "./mcp-server.js";
export * from "./harness.js";
export * from "./golden.js";
