-- The sandbox a stream's agent runs commands in. One per stream; the runner
-- owns the box, this row only says which one is current.

CREATE TABLE stream_sandboxes (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  runner TEXT NOT NULL,
  internet BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, stream_id)
);
