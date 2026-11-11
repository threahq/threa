CREATE TABLE link_favicons (
  workspace_id TEXT NOT NULL,
  host TEXT NOT NULL,
  content_type TEXT,
  bytes BYTEA,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, host)
);
