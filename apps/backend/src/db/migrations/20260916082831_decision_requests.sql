-- Decision requests: a bot runtime puts a call it cannot make to its human as
-- a timeline card. Tracking table (INV-57); kind/status are TEXT validated in
-- code (INV-3); every write CASes on `version` (INV-66). Requester columns are
-- nullable because a human may open one; a bot pins the session/invocation so
-- the answer is pushed back to that session's socket room.
CREATE TABLE IF NOT EXISTS decision_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  requester_bot_id TEXT,
  requester_runtime_session_id TEXT,
  requester_invocation_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_markdown TEXT,
  options JSONB NOT NULL,
  allow_note BOOLEAN NOT NULL DEFAULT false,
  external_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution JSONB,
  expires_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-stream listing (the member-facing "open decisions here" read).
CREATE INDEX IF NOT EXISTS idx_decision_requests_workspace_stream
  ON decision_requests (workspace_id, stream_id);

-- The expiry sweep's only read: rows past their deadline that are still open.
-- Partial so the index stays the size of the open set, not the history.
CREATE INDEX IF NOT EXISTS idx_decision_requests_expiring
  ON decision_requests (expires_at)
  WHERE status = 'open';
