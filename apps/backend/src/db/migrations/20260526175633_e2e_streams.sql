CREATE TABLE e2e_streams (
  stream_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_user_id TEXT NOT NULL,
  owner_user_key_id TEXT NOT NULL,
  invited_agent_kind TEXT NOT NULL,
  invited_agent_key_id TEXT
);

CREATE INDEX idx_e2e_streams_workspace
  ON e2e_streams (workspace_id, enabled_at DESC);

CREATE INDEX idx_e2e_streams_owner_key
  ON e2e_streams (workspace_id, owner_user_key_id);

ALTER TABLE messages
  ADD COLUMN ciphertext BYTEA,
  ADD COLUMN envelope JSONB,
  ADD COLUMN e2e_version SMALLINT;
