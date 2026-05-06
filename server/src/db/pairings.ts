import { randomBytes } from "node:crypto";
import type { Db } from "./pool.js";

export type PairingRow = {
  pairingCode: string;
  slackWorkspaceId: string;
  slackUserId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  machineId: string | null;
};

function generateCode(): string {
  const b = randomBytes(6).toString("hex");
  return `PAIR-${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 12)}`.toUpperCase();
}

export function createPairing(
  db: Db,
  args: { workspaceId: string; userId: string; ttlMinutes?: number }
): { pairingCode: string; expiresAt: Date } {
  const ttl = args.ttlMinutes ?? 15;
  const code = generateCode();
  const expiresAt = Date.now() + ttl * 60_000;
  db.prepare(
    `INSERT INTO pairings (pairing_code, slack_workspace_id, slack_user_id, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(code, args.workspaceId, args.userId, expiresAt);
  return { pairingCode: code, expiresAt: new Date(expiresAt) };
}

export function findLivePairing(db: Db, code: string): PairingRow | null {
  const row = db
    .prepare(
      `SELECT pairing_code, slack_workspace_id, slack_user_id, expires_at, consumed_at, machine_id
       FROM pairings
       WHERE pairing_code = ? AND consumed_at IS NULL AND expires_at > ?`
    )
    .get(code, Date.now()) as any;
  if (!row) return null;
  return {
    pairingCode: row.pairing_code,
    slackWorkspaceId: row.slack_workspace_id,
    slackUserId: row.slack_user_id,
    expiresAt: new Date(Number(row.expires_at)),
    consumedAt: row.consumed_at == null ? null : new Date(Number(row.consumed_at)),
    machineId: row.machine_id,
  };
}

export function consumePairing(
  db: Db,
  args: { pairingCode: string; machineId: string }
): void {
  db.prepare(
    `UPDATE pairings SET consumed_at = ?, machine_id = ?
     WHERE pairing_code = ? AND consumed_at IS NULL`
  ).run(Date.now(), args.machineId, args.pairingCode);
}
