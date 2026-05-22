CREATE TABLE stream_labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_stream_labels_workspace_owner_slug
  ON stream_labels (workspace_id, owner_user_id, slug)
  WHERE owner_user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_stream_labels_workspace_slug
  ON stream_labels (workspace_id, slug)
  WHERE owner_user_id IS NULL;

CREATE TABLE stream_label_assignments (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, stream_id, label_id)
);

CREATE INDEX idx_stream_labels_workspace_owner
  ON stream_labels (workspace_id, owner_user_id);

CREATE INDEX idx_stream_label_assignments_label
  ON stream_label_assignments (workspace_id, label_id);
