import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

export class ClaimError extends Error {
  constructor(public code: "unknown" | "expired" | "consumed", message: string) {
    super(message);
  }
}

export type ClaimResult = { machineId: string; revokedPrevious: number };

export async function claimPairing(
  pool: Pool,
  args: { code: string; publicKey: Buffer; label?: string }
): Promise<ClaimResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the pairing row so two concurrent claims serialize.
    const live = await client.query(
      `SELECT pairing_code, slack_workspace_id, slack_user_id, expires_at, consumed_at
       FROM pairings WHERE pairing_code = $1 FOR UPDATE`,
      [args.code]
    );
    if (live.rows.length === 0) {
      throw new ClaimError("unknown", "unknown pairing code");
    }
    const row = live.rows[0]!;
    if (row.consumed_at !== null) {
      throw new ClaimError("consumed", "pairing code already used");
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new ClaimError("expired", "pairing code expired");
    }
    const workspaceId = row.slack_workspace_id as string;
    const userId = row.slack_user_id as string;
    const revoked = await revokeActiveByUserTx(client, { workspaceId, userId });
    const inserted = await insertMachineTx(client, {
      workspaceId, userId, publicKey: args.publicKey, label: args.label,
    });
    await client.query(
      `UPDATE pairings SET consumed_at = now(), machine_id = $2
       WHERE pairing_code = $1`,
      [args.code, inserted.machineId]
    );
    await client.query("COMMIT");
    return { machineId: inserted.machineId, revokedPrevious: revoked };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Intra-transaction variants of repo functions: they take a client, not a pool.
async function revokeActiveByUserTx(
  client: PoolClient,
  args: { workspaceId: string; userId: string }
): Promise<number> {
  const r = await client.query(
    `UPDATE machines SET status = 'revoked', revoked_at = now()
     WHERE slack_workspace_id = $1 AND slack_user_id = $2 AND status = 'active'`,
    [args.workspaceId, args.userId]
  );
  return r.rowCount ?? 0;
}

async function insertMachineTx(
  client: PoolClient,
  args: { workspaceId: string; userId: string; publicKey: Buffer; label?: string }
): Promise<{ machineId: string }> {
  // Generate the UUID in application code so pg-mem's cached gen_random_uuid()
  // mock doesn't produce PK collisions across tests that insert multiple machines.
  const machineId = randomUUID();
  await client.query(
    `INSERT INTO machines (machine_id, slack_workspace_id, slack_user_id, public_key, label, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [machineId, args.workspaceId, args.userId, args.publicKey, args.label ?? null]
  );
  return { machineId };
}
