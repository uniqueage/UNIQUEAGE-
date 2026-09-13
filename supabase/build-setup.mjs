/**
 * UAGE backend — SETUP.sql generator.
 *
 * The migrations in supabase/migrations/ are the source of truth and the way
 * the schema will eventually be applied (supabase db push). But the site is a
 * static GitHub Pages deployment with no server and no CLI to hand, so the
 * owner often has to create the schema by pasting SQL into the Supabase SQL
 * editor. Pasting five files in the right order is easy to get wrong, so this
 * script emits one ordered file: supabase/SETUP.sql.
 *
 * SETUP.sql is GENERATED — never edit it by hand. Edit the migrations and
 * re-run:
 *
 *     node supabase/build-setup.mjs
 *
 * The test suite fails if SETUP.sql drifts out of sync with the migrations.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "migrations");
const OUTPUT = join(HERE, "SETUP.sql");

/** Ordered migration files — the sort is by timestamp prefix, so order is implied. */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

/** The exact text SETUP.sql must contain for a given set of migration files. */
export function expectedSetupSql(files = migrationFiles()) {
  const banner = [
    "-- ===========================================================================",
    "-- UAGE — COMPLETE DATABASE SETUP (generated file — do not edit by hand)",
    "-- ===========================================================================",
    "--",
    "-- Paste this WHOLE file into the Supabase SQL editor and run it once:",
    "--",
    "--   https://supabase.com/dashboard/project/<your-project-ref>/sql/new",
    "--",
    "-- It creates every type, table, constraint, index, trigger, Row Level",
    "-- Security policy, the trusted order function, the storage buckets and your",
    "-- full product catalogue — in the correct dependency order.",
    "--",
    "-- Safe to re-run: nothing is ever dropped, and existing rows are untouched.",
    "--",
    "-- Source of truth: supabase/migrations/*.sql",
    "-- Regenerate with: node supabase/build-setup.mjs",
    "-- ===========================================================================",
    "",
  ].join("\n");

  const parts = files.map((file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").trimEnd();
    const header = [
      "",
      "-- ---------------------------------------------------------------------------",
      `-- ${file}`,
      "-- ---------------------------------------------------------------------------",
      "",
    ].join("\n");
    return header + sql;
  });

  return `${banner}\n${parts.join("\n\n")}\n`;
}

/** Writes SETUP.sql and returns its content. */
export function buildSetupSql() {
  const sql = expectedSetupSql();
  writeFileSync(OUTPUT, sql, "utf8");
  return sql;
}

/* Only write when executed directly (not when imported by the test suite). */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = migrationFiles();
  const sql = buildSetupSql();
  console.log(`Wrote ${OUTPUT}`);
  console.log(`  ${files.length} migrations, ${sql.split("\n").length} lines`);
  for (const file of files) console.log(`    + ${file}`);
}
