-- =============================================================================
-- Label members: backfill creator memberships
-- Unifies the membership model — every label now carries a `label_members` row
-- for its creator, including private labels (which previously derived ownership
-- implicitly from `creator_user_id`). Public labels already have this row from
-- the create path, so the upsert is a no-op for them. Archived labels are
-- skipped: archiving deletes their memberships, and they must not be revived.
-- joined_at mirrors the label's creation time for historical accuracy.
-- =============================================================================

INSERT INTO label_members (label_id, user_id, workspace_id, joined_at)
SELECT id, creator_user_id, workspace_id, created_at
FROM labels
WHERE archived_at IS NULL
ON CONFLICT (label_id, user_id) DO NOTHING;
