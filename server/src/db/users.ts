import type { Pool } from "pg";

export async function upsertUser(
  pool: Pool,
  args: { workspaceId: string; userId: string; displayName?: string }
): Promise<void> {
  await pool.query(
    `INSERT INTO users (slack_workspace_id, slack_user_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (slack_workspace_id, slack_user_id)
     DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, users.display_name)`,
    [args.workspaceId, args.userId, args.displayName ?? null]
  );
}
