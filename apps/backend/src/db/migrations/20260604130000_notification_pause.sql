-- Do Not Disturb / notification pause.
--
-- Two independent sources can silence a user's notifications, both self-expiring
-- so the effective "paused right now?" is a pure function of the row + now:
--   1. status_pauses_notifications — the active status silences notifications
--      for its lifetime (bounded by status_expires_at). This is what turns the
--      cosmetic "Do not disturb" status into real do-not-disturb.
--   2. notifications_paused_until / notifications_paused_indefinitely — a manual
--      pause set without touching the status ("pause for an hour" / "until I
--      turn it back on"). Survives status changes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_pauses_notifications BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_paused_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_paused_indefinitely BOOLEAN NOT NULL DEFAULT false;
