import { randomUUID } from "node:crypto";
import type { Db } from "./pool.js";

export type MachineRow = {
  machineId: string;
  slackWorkspaceId: string;
  slackUserId: string;
  publicKey: Buffer;
  label: string | null;
  status: "active" | "revoked";
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
};

function rowToMachine(row: any): MachineRow {
  return {
    machineId: row.machine_id,
    slackWorkspaceId: row.slack_workspace_id,
    slackUserId: row.slack_user_id,
    publicKey: row.public_key,
    label: row.label,
    status: row.status,
    createdAt: new Date(Number(row.created_at)),
    lastSeenAt: row.last_seen_at == null ? null : new Date(Number(row.last_seen_at)),
    revokedAt: row.revoked_at == null ? null : new Date(Number(row.revoked_at)),
  };
}

export function insertMachine(
  db: Db,
  args: { workspaceId: string; userId: string; publicKey: Buffer; label?: string }
): MachineRow {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO machines
       (machine_id, slack_workspace_id, slack_user_id, public_key, label, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  ).run(id, args.workspaceId, args.userId, args.publicKey, args.label ?? null, now);
  const row = db.prepare(`SELECT * FROM machines WHERE machine_id = ?`).get(id);
  return rowToMachine(row);
}

export function listActiveByUser(
  db: Db,
  args: { workspaceId: string; userId: string }
): MachineRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM machines
       WHERE slack_workspace_id = ? AND slack_user_id = ? AND status = 'active'
       ORDER BY created_at DESC`
    )
    .all(args.workspaceId, args.userId) as any[];
  return rows.map(rowToMachine);
}

export function findActiveById(db: Db, machineId: string): MachineRow | null {
  const row = db
    .prepare(`SELECT * FROM machines WHERE machine_id = ? AND status = 'active'`)
    .get(machineId);
  return row ? rowToMachine(row) : null;
}

export function revokeActiveByUser(
  db: Db,
  args: { workspaceId: string; userId: string }
): number {
  const r = db
    .prepare(
      `UPDATE machines SET status = 'revoked', revoked_at = ?
       WHERE slack_workspace_id = ? AND slack_user_id = ? AND status = 'active'`
    )
    .run(Date.now(), args.workspaceId, args.userId);
  return r.changes ?? 0;
}

export function revokeById(db: Db, machineId: string): void {
  db.prepare(
    `UPDATE machines SET status = 'revoked', revoked_at = ?
     WHERE machine_id = ? AND status = 'active'`
  ).run(Date.now(), machineId);
}

export function touchLastSeen(db: Db, machineId: string): void {
  db.prepare(`UPDATE machines SET last_seen_at = ? WHERE machine_id = ?`).run(Date.now(), machineId);
}
