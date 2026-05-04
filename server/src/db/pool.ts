import pg from "pg";

export type DbPool = pg.Pool;

export function createPool(databaseUrl: string): DbPool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

/** Run the bundled migration(s) idempotently. */
export async function migrate(pool: DbPool): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "migrations", "0001_init.sql"), "utf8");
  await pool.query(sql);
}
