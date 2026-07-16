/**
 * @teaspill/harness-native — the harness interface (T3.1) and, later, the
 * pi-ai step-durable loop implementation (T3.2).
 *
 * `./interface.js` + `./context.js` are the dependency-light contract modules
 * that `@teaspill/harness-casdk` and `@teaspill/agents-sdk` import. STATUS:
 * PROPOSED — freezes with the T0.1 schema at gate G3.
 */

export * from "./interface.js";
export * from "./context.js";
