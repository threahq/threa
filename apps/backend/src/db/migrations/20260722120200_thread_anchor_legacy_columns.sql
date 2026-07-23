-- The canonical anchor and thread-row reply stats are authoritative after the
-- cleanup reconciler and concurrent legacy-index drop. IF EXISTS also lets an
-- environment that applied the original combined cleanup migrate safely.
ALTER TABLE streams DROP COLUMN IF EXISTS parent_message_id;

-- Reply stats now live on the thread stream row (streams.reply_count); the
-- message wire `replyCount` derives via join on parent_anchor_id.
ALTER TABLE messages DROP COLUMN IF EXISTS reply_count;

-- The scheduled-message parent is semantically a thread anchor id (msg_…), not a
-- distinct "parent message" concept. PostgreSQL has no RENAME COLUMN IF EXISTS,
-- so guard the compatibility rename explicitly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'scheduled_messages'
      AND column_name = 'parent_message_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'scheduled_messages'
      AND column_name = 'parent_anchor_id'
  ) THEN
    ALTER TABLE scheduled_messages RENAME COLUMN parent_message_id TO parent_anchor_id;
  END IF;
END
$$;
