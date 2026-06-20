-- Simplify labels: every label is now private, owned by its creating actor.
-- The public/private split is gone, and with it the `label_members` table —
-- membership only ever existed to model the public "join" concept. A private
-- label's sole member is its creator, already captured by `creator_user_id`.
--
-- Pre-release change: there is no production label data to preserve, so the old
-- public rows are simply collapsed into the per-actor namespace. Slug uniqueness
-- moves from a visibility-split pair of partial indexes to a single per-owner
-- index. (`creator_user_id` holds the actor's id — a user or a bot — and those
-- ids never collide, so per-owner uniqueness is well defined for both.)

DROP INDEX IF EXISTS uq_labels_workspace_public_slug;
DROP INDEX IF EXISTS uq_labels_workspace_private_owner_slug;
DROP INDEX IF EXISTS idx_labels_workspace_visibility;

ALTER TABLE labels DROP COLUMN visibility;

CREATE UNIQUE INDEX uq_labels_workspace_owner_slug
  ON labels (workspace_id, creator_user_id, slug)
  WHERE archived_at IS NULL;

DROP TABLE IF EXISTS label_members;
