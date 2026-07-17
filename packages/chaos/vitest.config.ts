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
  },
});
