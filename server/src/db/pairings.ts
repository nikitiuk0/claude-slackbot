import type { Pool } from "pg";
import { randomBytes } from "node:crypto";

export type PairingRow = {
  pairingCode: string;
  slackWorkspaceId: string;
  slackUserId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  machineId: string | null;
};

function generateCode(): string {
  const b = randomBytes(6).toString("hex"); // 12 hex chars
  return `PAIR-${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 12)}`.toUpperCase();
}

export async function createPairing(
  pool: Pool,
  args: { workspaceId: string; userId: string; ttlMinutes?: number }
): Promise<{ pairingCode: string; expiresAt: Date }> {
  const ttl = args.ttlMinutes ?? 15;
  const code = generateCode();
  const res = await pool.query<{ expires_at: Date }>(
    `INSERT INTO pairings (pairing_code, slack_workspace_id, slack_user_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
     RETURNING expires_at`,
    [code, args.workspaceId, args.userId, String(ttl)]
  );
  return { pairingCode: code, expiresAt: res.rows[0]!.expires_at };
}

export async function findLivePairing(pool: Pool, code: string): Promise<PairingRow | null> {
  const r = await pool.query(
    `SELECT pairing_code, slack_workspace_id, slack_user_id, expires_at, consumed_at, machine_id
     FROM pairings
     WHERE pairing_code = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [code]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0]!;
  return {
    pairingCode: row.pairing_code,
    slackWorkspaceId: row.slack_workspace_id,
    slackUserId: row.slack_user_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    machineId: row.machine_id,
  };
}

export async function consumePairing(
  pool: Pool,
  args: { pairingCode: string; machineId: string }
): Promise<void> {
  await pool.query(
    `UPDATE pairings SET consumed_at = now(), machine_id = $2
     WHERE pairing_code = $1 AND consumed_at IS NULL`,
    [args.pairingCode, args.machineId]
  );
}
