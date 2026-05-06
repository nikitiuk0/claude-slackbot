import type { Db } from "./pool.js";

export function upsertUser(
  db: Db,
  args: { workspaceId: string; userId: string; displayName?: string }
): void {
  db.prepare(
    `INSERT INTO users (slack_workspace_id, slack_user_id, display_name)
     VALUES (?, ?, ?)
     ON CONFLICT (slack_workspace_id, slack_user_id)
     DO UPDATE SET display_name = COALESCE(excluded.display_name, users.display_name)`
  ).run(args.workspaceId, args.userId, args.displayName ?? null);
}
