-- Add a `version` integer column to workspace_integrations for optimistic
-- concurrency control on the cache/credential write paths (INV-66). The
-- identity + status guards already close cross-installation corruption and
-- disconnect resurrection, but SAME-installation lost updates remain: the
-- rate-limit and repo-sync writes replace the ENTIRE credentials/metadata
-- object, so a stale writer that read before a concurrent write can clobber it
-- (e.g. a slow rate-limit write erasing a newer repo-sync's repositories list).
-- An integer version compared-and-set makes the stale writer lose.
--
-- Follows scheduled_messages.version / link_previews.refresh_version: a
-- monotonically increasing integer avoids the TIMESTAMPTZ-microsecond vs JS
-- Date-millisecond mismatch that breaks a `fetched_at = $expected` CAS.
--
-- Default = 1 for both new rows and the back-fill. EVERY update increments the
-- version; the cache/credential writes additionally CAS on it. Lifecycle
-- writes (disconnect, deactivate, install/replace upsert) bump the version but
-- do NOT CAS — a concurrent background refresh's version bump must never make a
-- user's disconnect silently no-op.

ALTER TABLE workspace_integrations
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
