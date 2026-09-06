ALTER TABLE workspace_invitations
  ALTER COLUMN expires_at DROP NOT NULL,
  ADD COLUMN parent_link_id TEXT,
  ADD COLUMN max_uses INTEGER DEFAULT 1,
  ADD COLUMN accepted_workos_user_id TEXT,
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

UPDATE workspace_invitations
SET max_uses = NULL
WHERE kind = 'email';

ALTER TABLE workspace_invitations
  ADD CONSTRAINT workspace_invitations_max_uses_positive
  CHECK (max_uses IS NULL OR max_uses > 0),
  ADD CONSTRAINT workspace_invitations_parent_link_shape
  CHECK (parent_link_id IS NULL OR (kind = 'link' AND email IS NOT NULL AND token_hash IS NULL));

CREATE UNIQUE INDEX idx_workspace_invitations_parent_email
  ON workspace_invitations (parent_link_id, lower(email))
  WHERE parent_link_id IS NOT NULL;

CREATE INDEX idx_workspace_invitations_parent
  ON workspace_invitations (workspace_id, parent_link_id)
  WHERE parent_link_id IS NOT NULL;
