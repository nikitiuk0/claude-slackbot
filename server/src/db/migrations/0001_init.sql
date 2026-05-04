CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  slack_workspace_id TEXT NOT NULL,
  slack_user_id      TEXT NOT NULL,
  display_name       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slack_workspace_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS machines (
  machine_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_workspace_id TEXT        NOT NULL,
  slack_user_id      TEXT        NOT NULL,
  public_key         BYTEA       NOT NULL,
  label              TEXT,
  status             TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  FOREIGN KEY (slack_workspace_id, slack_user_id)
    REFERENCES users(slack_workspace_id, slack_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS machines_one_active_per_user
  ON machines (slack_workspace_id, slack_user_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS pairings (
  pairing_code       TEXT        PRIMARY KEY,
  slack_workspace_id TEXT        NOT NULL,
  slack_user_id      TEXT        NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_at        TIMESTAMPTZ,
  machine_id         UUID
);

CREATE INDEX IF NOT EXISTS pairings_pending
  ON pairings (slack_workspace_id, slack_user_id)
  WHERE consumed_at IS NULL;
