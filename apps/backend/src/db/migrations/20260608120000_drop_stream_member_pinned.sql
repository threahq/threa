-- =============================================================================
-- Drop stream-member pinning
-- The "Pinned" smart sidebar bucket was never wired up end to end: no frontend
-- ever called the pin endpoint, the categorizer never produced a "pinned"
-- bucket, and the section rendered empty for every user. Custom sections cover
-- the same "keep these streams handy" workflow with more flexibility, so the
-- pinning columns + index are removed along with their backend/frontend code.
-- =============================================================================

DROP INDEX IF EXISTS idx_stream_members_pinned;

ALTER TABLE stream_members DROP COLUMN IF EXISTS pinned;
ALTER TABLE stream_members DROP COLUMN IF EXISTS pinned_at;
