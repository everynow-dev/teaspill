import { defineConfig } from "vitest/config";

// Root config for `vitest` run from the repo root (e.g. an editor integration
// or `pnpm exec vitest`). Each package also runs standalone via its own
// `pnpm --filter <pkg> test` / `pnpm -r test`, which is what CI uses.
// `projects` lets a single root invocation discover and run every package's
// tests together without a separate `vitest.workspace.ts` file.
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
