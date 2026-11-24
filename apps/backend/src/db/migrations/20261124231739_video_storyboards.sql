-- On-demand hover-preview sprites for video attachments (tracking state, INV-57).
-- status: pending | ready | failed (validated in code, INV-3).

CREATE TABLE IF NOT EXISTS video_storyboards (
  workspace_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  storage_path TEXT,
  tile_columns INTEGER,
  tile_rows INTEGER,
  tile_width INTEGER,
  tile_height INTEGER,
  tile_count INTEGER,
  interval_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, attachment_id)
);
