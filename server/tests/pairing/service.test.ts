import { describe, it, expect } from "vitest";
import * as users from "../../src/db/users.js";
import * as pairings from "../../src/db/pairings.js";
import * as machines from "../../src/db/machines.js";
import { claimPairing, ClaimError } from "../../src/pairing/service.js";
import { freshDb } from "../test-helpers/db.js";

describe("claimPairing", () => {
  it("happy path: insert new machine, consume code, return machine_id", () => {
    const db = freshDb();
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    const p = pairings.createPairing(db, { workspaceId: "T1", userId: "U1" });
    const res = claimPairing(db, { code: p.pairingCode, publicKey: Buffer.from("pk"), label: "m1" });
    expect(res.machineId).toBeTruthy();
    expect(res.revokedPrevious).toBe(0);
    expect(pairings.findLivePairing(db, p.pairingCode)).toBeNull();
  });

  it("auto-revokes previous active machines in the same transaction", () => {
    const db = freshDb();
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    machines.insertMachine(db, { workspaceId: "T1", userId: "U1", publicKey: Buffer.from("old"), label: "old" });
    const p = pairings.createPairing(db, { workspaceId: "T1", userId: "U1" });
    const res = claimPairing(db, { code: p.pairingCode, publicKey: Buffer.from("new"), label: "new" });
    expect(res.revokedPrevious).toBe(1);
    const active = machines.listActiveByUser(db, { workspaceId: "T1", userId: "U1" });
    expect(active).toHaveLength(1);
    expect(active[0]!.label).toBe("new");
  });

  it("rejects unknown code", () => {
    const db = freshDb();
    expect(() =>
      claimPairing(db, { code: "PAIR-nope", publicKey: Buffer.from("pk") })
    ).toThrow(/unknown/i);
  });

  it("rejects already-consumed code", () => {
    const db = freshDb();
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    const p = pairings.createPairing(db, { workspaceId: "T1", userId: "U1" });
    claimPairing(db, { code: p.pairingCode, publicKey: Buffer.from("pk1") });
    expect(() =>
      claimPairing(db, { code: p.pairingCode, publicKey: Buffer.from("pk2") })
    ).toThrow(ClaimError);
  });
});
