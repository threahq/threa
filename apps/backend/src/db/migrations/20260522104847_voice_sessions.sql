-- Voice dictation sessions (voice memos & dictation, PR1 walking skeleton).
-- Tracks one realtime speech-to-text session per dictation. No audio bytes or
-- transcript text are persisted here — metadata only, for cost telemetry and
-- residency audit. Workspace-scoped (INV-8); relational integrity enforced in
-- application code, no foreign keys (INV-1); TEXT status validated in code (INV-3).

CREATE TABLE IF NOT EXISTS voice_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  region TEXT NOT NULL,
  language TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  total_audio_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Find a user's active session quickly (one active dictation per user).
CREATE INDEX IF NOT EXISTS idx_voice_sessions_user_status
  ON voice_sessions (workspace_id, user_id, status);

-- Sweeper scan for sessions past their hard expiry.
CREATE INDEX IF NOT EXISTS idx_voice_sessions_expiry
  ON voice_sessions (status, expires_at);
