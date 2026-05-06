import Database, { type Database as SqliteDb } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Db = SqliteDb;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  return db;
}

export function migrate(db: Db): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "migrations", "0001_init.sql"), "utf8");
  db.exec(sql);
}
