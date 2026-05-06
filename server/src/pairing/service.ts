import { randomUUID } from "node:crypto";
import type { Db } from "../db/pool.js";

export class ClaimError extends Error {
  constructor(public code: "unknown" | "expired" | "consumed", message: string) {
    super(message);
  }
}

export type ClaimResult = { machineId: string; revokedPrevious: number };

export function claimPairing(
  db: Db,
  args: { code: string; publicKey: Buffer; label?: string }
): ClaimResult {
  const tx = db.transaction((): ClaimResult => {
    const row = db
      .prepare(
        `SELECT pairing_code, slack_workspace_id, slack_user_id, expires_at, consumed_at
         FROM pairings WHERE pairing_code = ?`
      )
      .get(args.code) as any;
    if (!row) {
      throw new ClaimError("unknown", "unknown pairing code");
    }
    if (row.consumed_at !== null) {
      throw new ClaimError("consumed", "pairing code already used");
    }
    if (Number(row.expires_at) <= Date.now()) {
      throw new ClaimError("expired", "pairing code expired");
    }
    const workspaceId = row.slack_workspace_id as string;
    const userId = row.slack_user_id as string;

    const now = Date.now();
    const revokedRes = db
      .prepare(
        `UPDATE machines SET status = 'revoked', revoked_at = ?
         WHERE slack_workspace_id = ? AND slack_user_id = ? AND status = 'active'`
      )
      .run(now, workspaceId, userId);

    const machineId = randomUUID();
    db.prepare(
      `INSERT INTO machines
         (machine_id, slack_workspace_id, slack_user_id, public_key, label, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    ).run(machineId, workspaceId, userId, args.publicKey, args.label ?? null, now);

    db.prepare(
      `UPDATE pairings SET consumed_at = ?, machine_id = ?
       WHERE pairing_code = ?`
    ).run(now, machineId, args.code);

    return { machineId, revokedPrevious: revokedRes.changes ?? 0 };
  });
  return tx();
}
