CREATE TABLE bot_runtime_pairing_codes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_user_id TEXT,
  consumed_stream_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, bot_id, code_hash)
);

CREATE INDEX idx_bot_runtime_pairing_codes_lookup
  ON bot_runtime_pairing_codes (workspace_id, bot_id, code_hash)
  WHERE consumed_at IS NULL;

CREATE INDEX idx_bot_runtime_pairing_codes_expiry
  ON bot_runtime_pairing_codes (expires_at)
  WHERE consumed_at IS NULL;
