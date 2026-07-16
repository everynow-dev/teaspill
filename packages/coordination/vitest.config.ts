import { defineConfig } from "vitest/config";

// A local config file (even a near-empty one) stops Vitest's upward config
// search at this package, so `vitest run` here never picks up the root
// `vitest.config.ts` (whose `test.projects` glob is only meaningful when
// Vitest is invoked from the repo root).
export default defineConfig({
  test: {
    environment: "node",
  },
});
