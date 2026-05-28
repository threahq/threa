DROP TABLE IF EXISTS stream_label_assignments;
DROP TABLE IF EXISTS stream_labels;

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  color TEXT NOT NULL,
  emoji TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_labels_workspace_public_slug
  ON labels (workspace_id, slug)
  WHERE visibility = 'public' AND archived_at IS NULL;

CREATE UNIQUE INDEX uq_labels_workspace_private_owner_slug
  ON labels (workspace_id, creator_user_id, slug)
  WHERE visibility = 'private' AND archived_at IS NULL;

CREATE INDEX idx_labels_workspace_visibility
  ON labels (workspace_id, visibility)
  WHERE archived_at IS NULL;

CREATE INDEX idx_labels_workspace_creator
  ON labels (workspace_id, creator_user_id)
  WHERE archived_at IS NULL;

CREATE TABLE label_members (
  label_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (label_id, user_id)
);

CREATE INDEX idx_label_members_workspace_user
  ON label_members (workspace_id, user_id);
