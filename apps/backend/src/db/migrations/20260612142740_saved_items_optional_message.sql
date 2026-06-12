-- Generalize saved_messages from "saved message" to "saved item" (a to-do).
--
-- A saved item is either anchored to a message (the original bookmark flow)
-- or standalone (a manually created to-do with its own title). Standalone
-- rows have NULL message_id and NULL stream_id. All rows gain:
--   * title — required in app code when message_id IS NULL; the row's display
--     line. Message-anchored rows leave it NULL and render the live message
--     preview instead.
--   * note  — optional free-text context ("why I saved this"), editable on
--     both variants. Plain markdown text, not message contentJson — a note is
--     an annotation, not a message (INV-58 governs message content only).
--
-- The (workspace_id, user_id, message_id) unique index becomes partial so it
-- keeps being the INV-20 upsert conflict target for message saves while
-- allowing any number of standalone rows per user.
--
-- Per INV-1 no foreign keys; per INV-3 validation lives in application code.

ALTER TABLE saved_messages ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE saved_messages ALTER COLUMN stream_id DROP NOT NULL;
ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS note TEXT;

DROP INDEX IF EXISTS idx_saved_messages_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_messages_unique
  ON saved_messages (workspace_id, user_id, message_id)
  WHERE message_id IS NOT NULL;

-- Standalone saved-item reminders produce activity rows with no source
-- message or stream. The saved_reminder activity type is already excluded
-- from the (user_id, message_id, activity_type, actor_id) dedup index
-- (20260417200220), so NULLs here can't collide with it.

ALTER TABLE user_activity ALTER COLUMN stream_id DROP NOT NULL;
ALTER TABLE user_activity ALTER COLUMN message_id DROP NOT NULL;
