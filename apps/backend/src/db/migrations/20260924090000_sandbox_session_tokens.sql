-- Credentials for code running in an agent's sandbox. One per command run:
-- minted before the command starts, revoked when it ends. Reach is the
-- agent's for that turn (captured_stream_ids), narrowed on every request to
-- what the invoking user can still read.

CREATE TABLE sandbox_session_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  invoking_user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  captured_stream_ids TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX sandbox_session_tokens_hash_idx ON sandbox_session_tokens (token_hash);
CREATE INDEX sandbox_session_tokens_expires_idx ON sandbox_session_tokens (expires_at);
