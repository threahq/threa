-- Add a `refresh_version` integer column to link_previews for optimistic
-- concurrency control on the webhook force-refresh path. The previous CAS used
-- `fetched_at`, which had to fight Postgres TIMESTAMPTZ microsecond precision
-- vs the JS `Date` millisecond precision pg maps it to — passing a read-back
-- timestamp into `fetched_at IS NOT DISTINCT FROM $expected` failed on virtually
-- every uncontended write (the stored microseconds never equal the truncated
-- millisecond value), turning every refresh into a spurious conflict that could
-- leave a preview stale forever. A monotonically increasing integer version
-- doesn't have that problem and reads cleanly: "lock on version".
--
-- Default = 0 for both new rows and the back-fill. Every write that lands new
-- metadata (updateMetadata on the pending fetch path, overwriteMetadata on the
-- refresh path) increments the version, so any committed write advances it and
-- a refresh that captured an older version loses the compare-and-set.

ALTER TABLE link_previews
  ADD COLUMN IF NOT EXISTS refresh_version INTEGER NOT NULL DEFAULT 0;
