import { defineConfig } from "drizzle-kit";

// drizzle-kit CLI config (`db:generate`). Only used to (re)generate SQL
// migrations from src/schema.ts — the running services never import this
// file, they use `migrate()`/`MIGRATIONS_FOLDER` from src/client.ts.
// `dbCredentials.url` is only consulted by drizzle-kit subcommands that
// need a live connection (e.g. `drizzle-kit push`, `drizzle-kit studio`);
// `generate` (what this package actually uses, see package.json) does not
// connect to a database at all, so a missing/placeholder DATABASE_URL does
// not block it.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://placeholder/placeholder",
  },
});
