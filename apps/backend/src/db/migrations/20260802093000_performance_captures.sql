-- Client performance captures uploaded by a consenting user from the Diagnostics
-- settings tab. Closed-registry samples only (no ids, text, or URLs) — see
-- packages/types/src/performance-capture.ts. Rows are transient diagnostic
-- evidence, pruned after 14 days by PerfCaptureRetentionWorker.
CREATE TABLE performance_captures (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- Client-generated per capture session; deliberately not stable across
  -- sessions, so it cannot act as a device identifier.
  capture_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  device_class TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  sample_count INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  samples JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_performance_captures_created_at ON performance_captures (created_at);

CREATE INDEX idx_performance_captures_workspace_user
  ON performance_captures (workspace_id, user_id, created_at DESC);
