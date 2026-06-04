-- User statuses: cosmetic emoji + text shown beside a user's avatar, with an
-- optional auto-clear instant. Emoji is stored as a shortcode (no colons),
-- matching personas/bots/labels. Nullable — a user has no status by default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_emoji TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_expires_at TIMESTAMPTZ;
