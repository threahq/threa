ALTER TABLE invitation_shadows
  ALTER COLUMN expires_at DROP NOT NULL,
  ADD COLUMN parent_link_id TEXT,
  ADD COLUMN max_uses INTEGER,
  ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

UPDATE invitation_shadows
SET max_uses = 1
WHERE kind = 'link' AND token_hash IS NOT NULL;

ALTER TABLE invitation_shadows
  ADD CONSTRAINT invitation_shadows_max_uses_positive
    CHECK (max_uses IS NULL OR max_uses > 0),
  ADD CONSTRAINT invitation_shadows_use_count_nonnegative
    CHECK (use_count >= 0);

CREATE INDEX idx_invitation_shadows_parent_link
  ON invitation_shadows (parent_link_id)
  WHERE parent_link_id IS NOT NULL;
