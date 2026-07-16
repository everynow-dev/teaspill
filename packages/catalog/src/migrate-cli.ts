#!/usr/bin/env node
/**
 * `pnpm --filter @teaspill/catalog run db:migrate` — applies pending SQL
 * migrations from `drizzle/` against `DATABASE_URL`. Thin CLI wrapper
 * around `migrate()` for local/dev use; production deployments may prefer
 * to call `migrate()` from their own boot sequence instead.
 */

import { migrate } from "./client.js";

migrate()
  .then(() => {
    console.log("catalog: migrations applied");
  })
  .catch((err: unknown) => {
    console.error("catalog: migration failed", err);
    process.exitCode = 1;
  });
