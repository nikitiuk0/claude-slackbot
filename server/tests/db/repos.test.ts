import { describe, it, expect } from "vitest";
import * as users from "../../src/db/users.js";
import * as machines from "../../src/db/machines.js";
import * as pairings from "../../src/db/pairings.js";
import { freshDb } from "../test-helpers/db.js";

describe("users repo", () => {
  it("upsertUser is idempotent", () => {
    const db = freshDb();
    users.upsertUser(db, { workspaceId: "T1", userId: "U1", displayName: "Alice" });
    users.upsertUser(db, { workspaceId: "T1", userId: "U1", displayName: "Alice Updated" });
    const rows = db.prepare(`SELECT display_name FROM users WHERE slack_user_id = ?`).all("U1") as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].display_name).toBe("Alice Updated");

    // Calling without displayName preserves the existing one (COALESCE branch).
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    const rows2 = db.prepare(`SELECT display_name FROM users WHERE slack_user_id = ?`).all("U1") as any[];
    expect(rows2[0].display_name).toBe("Alice Updated");
  });
});

describe("pairings repo", () => {
  it("createPairing inserts a row with 15-min TTL", () => {
    const db = freshDb();
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    const row = pairings.createPairing(db, { workspaceId: "T1", userId: "U1" });
    expect(row.pairingCode).toMatch(/^PAIR-[A-Z0-9-]+$/);
    const r = db.prepare(`SELECT * FROM pairings WHERE pairing_code = ?`).all(row.pairingCode) as any[];
    expect(r).toHaveLength(1);
    const ageMs = Date.now() - Number(r[0].expires_at);
    expect(Math.abs(ageMs + 15 * 60_000)).toBeLessThan(60_000);
  });

  it("findLivePairing returns unconsumed, unexpired row", () => {
    const db = freshDb();
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    const row = pairings.createPairing(db, { workspaceId: "T1", userId: "U1" });
    const live = pairings.findLivePairing(db, row.pairingCode);
    expect(live?.slackUserId).toBe("U1");
  });

  it("findLivePairing returns null for consumed codes", () => {
    const db = freshDb();
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    const row = pairings.createPairing(db, { workspaceId: "T1", userId: "U1" });
    db.prepare(`UPDATE pairings SET consumed_at = ? WHERE pairing_code = ?`).run(Date.now(), row.pairingCode);
    const live = pairings.findLivePairing(db, row.pairingCode);
    expect(live).toBeNull();
  });
});

describe("machines repo", () => {
  it("insertMachine + listActiveByUser", () => {
    const db = freshDb();
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    const m = machines.insertMachine(db, {
      workspaceId: "T1", userId: "U1",
      publicKey: Buffer.from("pk"), label: "mac-1",
    });
    const active = machines.listActiveByUser(db, { workspaceId: "T1", userId: "U1" });
    expect(active).toHaveLength(1);
    expect(active[0]!.machineId).toBe(m.machineId);
  });

  it("revokeActiveByUser marks all active rows revoked", () => {
    const db = freshDb({ dropOneActivePerUserIndex: true });
    users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
    machines.insertMachine(db, {
      workspaceId: "T1", userId: "U1", publicKey: Buffer.from("pk1"), label: "m1",
    });
    machines.insertMachine(db, {
      workspaceId: "T1", userId: "U1", publicKey: Buffer.from("pk2"), label: "m2",
    });
    const revoked = machines.revokeActiveByUser(db, { workspaceId: "T1", userId: "U1" });
    expect(revoked).toBe(2);
    const active = machines.listActiveByUser(db, { workspaceId: "T1", userId: "U1" });
    expect(active).toHaveLength(0);

    const raw = db
      .prepare(`SELECT status, revoked_at FROM machines WHERE slack_workspace_id = ? AND slack_user_id = ?`)
      .all("T1", "U1") as any[];
    expect(raw.length).toBe(2);
    expect(raw.every((r) => r.status === "revoked")).toBe(true);
    expect(raw.every((r) => r.revoked_at !== null)).toBe(true);
  });
});
