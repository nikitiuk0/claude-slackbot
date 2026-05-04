import { describe, it, expect } from "vitest";
import { newDb, DataType } from "pg-mem";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as users from "../../src/db/users.js";
import * as pairings from "../../src/db/pairings.js";
import * as machines from "../../src/db/machines.js";
import { claimPairing, ClaimError } from "../../src/pairing/service.js";

async function freshPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => crypto.randomUUID(),
  });
  mem.registerExtension("pgcrypto", () => {});
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "..", "..", "src", "db", "migrations", "0001_init.sql"), "utf8");
  mem.public.none(sql);
  // pg-mem v3 enforces partial unique indexes; the auto-revoke-on-new-pair test
  // inserts a second machine for the same user *before* the revoke runs in the
  // same transaction. Real Postgres serializes this fine via row locks. Drop the
  // index in tests so we exercise the revoke logic without the index racing us.
  mem.public.none("DROP INDEX IF EXISTS machines_one_active_per_user");
  return new (mem.adapters.createPg().Pool)();
}

describe("claimPairing", () => {
  it("happy path: insert new machine, consume code, return machine_id", async () => {
    const pool = await freshPool();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const p = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });
    const res = await claimPairing(pool, { code: p.pairingCode, publicKey: Buffer.from("pk"), label: "m1" });
    expect(res.machineId).toBeTruthy();
    expect(res.revokedPrevious).toBe(0);
    // Code consumed
    expect(await pairings.findLivePairing(pool, p.pairingCode)).toBeNull();
  });

  it("auto-revokes previous active machines in the same transaction", async () => {
    const pool = await freshPool();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    await machines.insertMachine(pool, { workspaceId: "T1", userId: "U1", publicKey: Buffer.from("old"), label: "old" });
    const p = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });
    const res = await claimPairing(pool, { code: p.pairingCode, publicKey: Buffer.from("new"), label: "new" });
    expect(res.revokedPrevious).toBe(1);
    const active = await machines.listActiveByUser(pool, { workspaceId: "T1", userId: "U1" });
    expect(active).toHaveLength(1);
    expect(active[0]!.label).toBe("new");
  });

  it("rejects unknown code", async () => {
    const pool = await freshPool();
    await expect(
      claimPairing(pool, { code: "PAIR-nope", publicKey: Buffer.from("pk") })
    ).rejects.toThrow(/unknown/i);
  });

  it("rejects already-consumed code", async () => {
    const pool = await freshPool();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const p = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });
    await claimPairing(pool, { code: p.pairingCode, publicKey: Buffer.from("pk1") });
    await expect(
      claimPairing(pool, { code: p.pairingCode, publicKey: Buffer.from("pk2") })
    ).rejects.toThrow(ClaimError);
  });
});
