import { defineConfig } from "vitest/config";

// A local config file (even a near-empty one) stops Vitest's upward config
// search at this package, so `vitest run` here never picks up the root
// `vitest.config.ts` (whose `test.projects` glob is only meaningful when
// Vitest is invoked from the repo root). Chaos live tests shell out to
// `docker compose` and can restart real containers, so they are ALWAYS gated
// behind `TEASPILL_CHAOS=1` + `TEASPILL_STACK_URL` and skip cleanly otherwise.
export default defineConfig({
  test: {
    environment: "node",
    // 0002:T4.2 (same class as the conformance liveTestTimeout fix): the live
    // fault tests drive multi-minute kill→observe→assert cycles whose driver
    // windows (observeUntil up to 120s) exceed vitest's 5s default
    // testTimeout — without this ceiling every live chaos test dies at 5s
    // against a healthy stack. Offline tests are unaffected (a timeout is a
    // ceiling, not a wait). 0002:T4.3 may tighten per-test.
    testTimeout: 300_000,
  },
});
