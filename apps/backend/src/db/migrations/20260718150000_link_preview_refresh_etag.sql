-- Cache validator for conditional provider refreshes (viewport-nudge path).
-- Holds the ETag of the preview's PRIMARY provider resource (e.g. the pulls
-- endpoint for a PR card); a conditional refresh sends it as If-None-Match and
-- a 304 answer skips the full fetch without burning GitHub rate limit.
ALTER TABLE link_previews
  ADD COLUMN IF NOT EXISTS refresh_etag TEXT;
