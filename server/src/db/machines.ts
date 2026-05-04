import type { Pool } from "pg";

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
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export async function insertMachine(
  pool: Pool,
  args: { workspaceId: string; userId: string; publicKey: Buffer; label?: string }
): Promise<MachineRow> {
  const r = await pool.query(
    `INSERT INTO machines (slack_workspace_id, slack_user_id, public_key, label, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING *`,
    [args.workspaceId, args.userId, args.publicKey, args.label ?? null]
  );
  return rowToMachine(r.rows[0]);
}

export async function listActiveByUser(
  pool: Pool,
  args: { workspaceId: string; userId: string }
): Promise<MachineRow[]> {
  const r = await pool.query(
    `SELECT * FROM machines
     WHERE slack_workspace_id = $1 AND slack_user_id = $2 AND status = 'active'
     ORDER BY created_at DESC`,
    [args.workspaceId, args.userId]
  );
  return r.rows.map(rowToMachine);
}

export async function findActiveById(pool: Pool, machineId: string): Promise<MachineRow | null> {
  const r = await pool.query(
    `SELECT * FROM machines WHERE machine_id = $1 AND status = 'active'`,
    [machineId]
  );
  return r.rows.length === 0 ? null : rowToMachine(r.rows[0]);
}

export async function revokeActiveByUser(
  pool: Pool,
  args: { workspaceId: string; userId: string }
): Promise<number> {
  const r = await pool.query(
    `UPDATE machines SET status = 'revoked', revoked_at = now()
     WHERE slack_workspace_id = $1 AND slack_user_id = $2 AND status = 'active'`,
    [args.workspaceId, args.userId]
  );
  return r.rowCount ?? 0;
}

export async function revokeById(pool: Pool, machineId: string): Promise<void> {
  await pool.query(
    `UPDATE machines SET status = 'revoked', revoked_at = now()
     WHERE machine_id = $1 AND status = 'active'`,
    [machineId]
  );
}

export async function touchLastSeen(pool: Pool, machineId: string): Promise<void> {
  await pool.query(`UPDATE machines SET last_seen_at = now() WHERE machine_id = $1`, [machineId]);
}
