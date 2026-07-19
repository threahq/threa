-- Voice/video calls (M0 PR 0.2) — the media-plane columns the CF Realtime SFU
-- proxy and the `/calls` control gateway write. Append-only (INV-17), all TEXT
-- statuses/kinds validated in code (INV-3), workspace-scoped rows unchanged
-- (INV-8). No new tables: these extend the 0.1 tracking tables.
--
-- roster_version is the monotonic snapshot version every membership/media-state
-- change bumps (INV-66); clients drop a roster delta whose version is not newer
-- than what they hold, so a reordered socket fan-out can't regress state.
--
-- The endpoint gains its media identity here: cf_session_id (the CF Realtime
-- session, minted outside any DB transaction and CAS-written onto the row —
-- nullable until it exists), media_incarnation (client-minted per CallManager
-- lifetime, the fencing token for proxy calls so a reload's stale session can't
-- act on the new one), media_state (server-owned mute/camera claims mirrored to
-- clients), and published_tracks (the track registry CF pushes no notification
-- for, so it rides our roster).

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS roster_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE call_endpoints
  ADD COLUMN IF NOT EXISTS cf_session_id TEXT,
  ADD COLUMN IF NOT EXISTS media_incarnation TEXT,
  ADD COLUMN IF NOT EXISTS media_state JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS published_tracks JSONB NOT NULL DEFAULT '[]';
