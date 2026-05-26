CREATE TABLE e2e_scratchpads (
  stream_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_user_id TEXT NOT NULL,
  owner_user_key_id TEXT NOT NULL,
  invited_agent_kind TEXT NOT NULL,
  invited_agent_key_id TEXT
);

CREATE INDEX idx_e2e_scratchpads_workspace
  ON e2e_scratchpads (workspace_id, enabled_at DESC);

CREATE INDEX idx_e2e_scratchpads_owner_key
  ON e2e_scratchpads (workspace_id, owner_user_key_id);

ALTER TABLE messages
  ADD COLUMN ciphertext BYTEA,
  ADD COLUMN envelope JSONB,
  ADD COLUMN e2e_version SMALLINT;
