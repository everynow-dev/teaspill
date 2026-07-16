import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER } from "./client.js";

/**
 * Static SQL sanity checks for the checked-in migrations. Deliberately not
 * a full PostgreSQL parser (pulling one in for two small files is not
 * "boring") — instead: split into individual statements the same way
 * drizzle-orm's migrator does (`--> statement-breakpoint`), and assert each
 * statement is balanced (parens, dollar-quoted bodies) and every table/
 * column this package's schema.ts declares actually appears in the SQL. A
 * real Postgres round-trip (the strongest possible validation) is in
 * migrations.integration.test.ts, gated behind a live DATABASE_URL.
 */

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

/** Balanced-parens check that ignores parens inside string/dollar-quoted literals. */
function parensBalanced(statement: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < statement.length) {
    const ch = statement[i];
    if (ch === "$") {
      // dollar-quoted string: $$...$$ or $tag$...$tag$
      const m = /^\$[a-zA-Z_]*\$/.exec(statement.slice(i));
      if (m) {
        const tag = m[0];
        const end = statement.indexOf(tag, i + tag.length);
        if (end === -1) return false; // unterminated dollar quote
        i = end + tag.length;
        continue;
      }
    }
    if (ch === "'") {
      const end = statement.indexOf("'", i + 1);
      if (end === -1) return false;
      i = end + 1;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) return false;
    i++;
  }
  return depth === 0;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_FOLDER)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

describe("migration SQL files", () => {
  it("0000_init.sql and 0001_operational_setup.sql are present, in that order", () => {
    expect(migrationFiles()).toEqual([
      "0000_init.sql",
      "0001_operational_setup.sql",
    ]);
  });

  it("every migration file's statements are non-empty and balanced", () => {
    for (const file of migrationFiles()) {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, file), "utf8");
      const statements = splitStatements(sql);
      expect(statements.length, `${file} has no statements`).toBeGreaterThan(
        0,
      );
      for (const statement of statements) {
        expect(
          parensBalanced(statement),
          `${file}: unbalanced statement:\n${statement}`,
        ).toBe(true);
      }
    }
  });

  it("0000_init.sql declares all three tables and their documented columns", () => {
    const sql = readFileSync(
      join(MIGRATIONS_FOLDER, "0000_init.sql"),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE "entities"/);
    expect(sql).toMatch(/CREATE TABLE "entity_tags"/);
    expect(sql).toMatch(/CREATE TABLE "api_keys"/);
    for (const col of [
      "url",
      "tenant",
      "type",
      "status",
      "tags",
      "parent",
      "head_seq",
      "snapshot_offset",
      "archived_snapshot",
      "created_at",
      "updated_at",
    ]) {
      expect(sql, `entities missing column ${col}`).toMatch(
        new RegExp(`"${col}"`),
      );
    }
    expect(sql).toMatch(/entity_tags_url_entities_url_fk.*ON DELETE cascade/s);
  });

  it("0001_operational_setup.sql sets REPLICA IDENTITY FULL and the updated_at trigger", () => {
    const sql = readFileSync(
      join(MIGRATIONS_FOLDER, "0001_operational_setup.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ALTER TABLE "entities" REPLICA IDENTITY FULL/);
    expect(sql).toMatch(/ALTER TABLE "entity_tags" REPLICA IDENTITY FULL/);
    expect(sql).toMatch(/CREATE TRIGGER entities_set_updated_at/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION set_updated_at/);
  });
});
