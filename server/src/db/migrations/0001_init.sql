-- SQLite schema for the relay server.
-- All timestamps are stored as INTEGER unix milliseconds.

CREATE TABLE IF NOT EXISTS users (
  slack_workspace_id TEXT NOT NULL,
  slack_user_id      TEXT NOT NULL,
  display_name       TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (slack_workspace_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS machines (
  machine_id         TEXT PRIMARY KEY,
  slack_workspace_id TEXT NOT NULL,
  slack_user_id      TEXT NOT NULL,
  public_key         BLOB NOT NULL,
  label              TEXT,
  status             TEXT NOT NULL,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_seen_at       INTEGER,
  revoked_at         INTEGER,
  FOREIGN KEY (slack_workspace_id, slack_user_id)
    REFERENCES users(slack_workspace_id, slack_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS machines_one_active_per_user
  ON machines (slack_workspace_id, slack_user_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS pairings (
  pairing_code       TEXT PRIMARY KEY,
  slack_workspace_id TEXT NOT NULL,
  slack_user_id      TEXT NOT NULL,
  expires_at         INTEGER NOT NULL,
  consumed_at        INTEGER,
  machine_id         TEXT
);

CREATE INDEX IF NOT EXISTS pairings_pending
  ON pairings (slack_workspace_id, slack_user_id)
  WHERE consumed_at IS NULL;
