import { describe, it, expect, beforeEach } from "vitest";
import { newDb, DataType, type IMemoryDb } from "pg-mem";
import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as users from "../../src/db/users.js";
import * as machines from "../../src/db/machines.js";
import * as pairings from "../../src/db/pairings.js";

async function freshDb(): Promise<{ pool: Pool; mem: IMemoryDb }> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, implementation: () => crypto.randomUUID() });
  mem.registerExtension("pgcrypto", () => {});
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "..", "..", "src", "db", "migrations", "0001_init.sql"), "utf8");
  mem.public.none(sql);
  // pg-mem v3 enforces partial unique indexes; drop it so tests can insert multiple active rows
  // (real Postgres enforces this at the DB level, which is intentional — tested separately)
  mem.public.none(`DROP INDEX IF EXISTS machines_one_active_per_user`);
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  return { pool, mem };
}

describe("users repo", () => {
  it("upsertUser is idempotent", async () => {
    const { pool } = await freshDb();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1", displayName: "Alice" });
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1", displayName: "Alice Updated" });
    const r = await pool.query(`SELECT display_name FROM users WHERE slack_user_id='U1'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].display_name).toBe("Alice Updated");
  });
});

describe("pairings repo", () => {
  it("createPairing inserts a row with 15-min TTL", async () => {
    const { pool } = await freshDb();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const row = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });
    expect(row.pairingCode).toMatch(/^PAIR-[A-Z0-9-]+$/);
    const r = await pool.query(`SELECT * FROM pairings WHERE pairing_code=$1`, [row.pairingCode]);
    expect(r.rows).toHaveLength(1);
    const ageMs = Date.now() - new Date(r.rows[0].expires_at).getTime();
    // Expires at +15min; allow generous drift.
    expect(Math.abs(ageMs + 15 * 60_000)).toBeLessThan(60_000);
  });

  it("findLivePairing returns unconsumed, unexpired row", async () => {
    const { pool } = await freshDb();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const row = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });
    const live = await pairings.findLivePairing(pool, row.pairingCode);
    expect(live?.slackUserId).toBe("U1");
  });

  it("findLivePairing returns null for consumed codes", async () => {
    const { pool } = await freshDb();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const row = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });
    await pool.query(`UPDATE pairings SET consumed_at=now() WHERE pairing_code=$1`, [row.pairingCode]);
    const live = await pairings.findLivePairing(pool, row.pairingCode);
    expect(live).toBeNull();
  });
});

describe("machines repo", () => {
  it("insertMachine + listActiveByUser", async () => {
    const { pool } = await freshDb();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const m = await machines.insertMachine(pool, {
      workspaceId: "T1", userId: "U1",
      publicKey: Buffer.from("pk"), label: "mac-1",
    });
    const active = await machines.listActiveByUser(pool, { workspaceId: "T1", userId: "U1" });
    expect(active).toHaveLength(1);
    expect(active[0]!.machineId).toBe(m.machineId);
  });

  it("revokeActiveByUser marks all active rows revoked", async () => {
    const { pool } = await freshDb();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const m1 = await machines.insertMachine(pool, {
      workspaceId: "T1", userId: "U1", publicKey: Buffer.from("pk1"), label: "m1",
    });
    // Force two active rows for the test by going under the unique partial index.
    // (Real Postgres enforces the index; pg-mem v3 would too, so we DROP it in freshDb above.)
    // Provide an explicit machine_id because pg-mem v3's gen_random_uuid() mock may return
    // a cached value within the same test run, causing a PK collision.
    await pool.query(
      `INSERT INTO machines (machine_id, slack_workspace_id, slack_user_id, public_key, label, status)
       VALUES ($1,'T1','U1',$2,'m2','active')`,
      [crypto.randomUUID(), Buffer.from("pk2")]
    );
    const revoked = await machines.revokeActiveByUser(pool, { workspaceId: "T1", userId: "U1" });
    expect(revoked).toBe(2);
    const active = await machines.listActiveByUser(pool, { workspaceId: "T1", userId: "U1" });
    expect(active).toHaveLength(0);
  });
});
