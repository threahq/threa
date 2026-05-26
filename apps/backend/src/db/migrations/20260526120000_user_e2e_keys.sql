CREATE TABLE user_e2e_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  encrypted_private_bundle BYTEA NOT NULL,
  kdf_salt BYTEA NOT NULL,
  kdf_params JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_user_e2e_keys_active
  ON user_e2e_keys (workspace_id, user_id)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX uq_user_e2e_keys_key_id
  ON user_e2e_keys (workspace_id, key_id);

CREATE INDEX idx_user_e2e_keys_user
  ON user_e2e_keys (workspace_id, user_id, created_at DESC);
