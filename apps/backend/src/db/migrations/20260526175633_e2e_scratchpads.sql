CREATE TABLE e2e_scratchpads (
  stream_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_user_id TEXT NOT NULL,
  owner_user_key_id TEXT NOT NULL,
  invited_agent_kind TEXT NOT NULL,
  invited_agent_key_id TEXT,
  CONSTRAINT e2e_scratchpads_invited_agent_kind_chk
    CHECK (invited_agent_kind IN ('none', 'bot', 'enclave')),
  CONSTRAINT e2e_scratchpads_invited_agent_key_pair_chk
    CHECK (
      (invited_agent_kind = 'none' AND invited_agent_key_id IS NULL) OR
      (invited_agent_kind IN ('bot', 'enclave') AND invited_agent_key_id IS NOT NULL)
    )
);

CREATE INDEX idx_e2e_scratchpads_workspace
  ON e2e_scratchpads (workspace_id, enabled_at DESC);

CREATE INDEX idx_e2e_scratchpads_owner_key
  ON e2e_scratchpads (workspace_id, owner_user_key_id);

ALTER TABLE messages
  ADD COLUMN ciphertext BYTEA,
  ADD COLUMN envelope JSONB,
  ADD COLUMN e2e_version SMALLINT,
  ADD CONSTRAINT messages_e2e_payload_consistency_chk CHECK (
    (ciphertext IS NULL AND envelope IS NULL AND e2e_version IS NULL) OR
    (ciphertext IS NOT NULL AND envelope IS NOT NULL AND e2e_version IS NOT NULL AND e2e_version > 0)
  );
