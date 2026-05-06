import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../../src/db/pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "..", "..", "src", "db", "migrations", "0001_init.sql");

/**
 * Fresh in-memory SQLite database with the production schema applied.
 *
 * Optional `dropOneActivePerUserIndex` lets tests deliberately bypass the
 * partial-unique-index invariant when they need to insert multiple active
 * machines for the same user (e.g. revoke-all paths). Real prod enforces it.
 */
export function freshDb(opts: { dropOneActivePerUserIndex?: boolean } = {}): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  if (opts.dropOneActivePerUserIndex) {
    db.exec("DROP INDEX IF EXISTS machines_one_active_per_user");
  }
  return db;
}
