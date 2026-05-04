import { pgTable, text, uuid, timestamp, customType, primaryKey } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
});

export const users = pgTable(
  "users",
  {
    slackWorkspaceId: text("slack_workspace_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.slackWorkspaceId, t.slackUserId] }) })
);

export const machines = pgTable("machines", {
  machineId: uuid("machine_id").primaryKey().defaultRandom(),
  slackWorkspaceId: text("slack_workspace_id").notNull(),
  slackUserId: text("slack_user_id").notNull(),
  publicKey: bytea("public_key").notNull(),
  label: text("label"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const pairings = pgTable("pairings", {
  pairingCode: text("pairing_code").primaryKey(),
  slackWorkspaceId: text("slack_workspace_id").notNull(),
  slackUserId: text("slack_user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  machineId: uuid("machine_id"),
});
