-- Keep the canonical thread-row projection correct while predecessor replicas
-- still update only messages.reply_count during the rolling deploy. Creating the
-- trigger takes a table lock for this transaction, so the following reconciliation
-- cannot race a legacy reply-count write.
CREATE OR REPLACE FUNCTION sync_legacy_message_thread_projection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE streams AS thread
  SET reply_count = NEW.reply_count,
      last_reply_at = (
        SELECT MAX(created_at)
        FROM messages
        WHERE stream_id = thread.id
          AND deleted_at IS NULL
      ),
      updated_at = NOW()
  WHERE thread.type = 'thread'
    AND thread.parent_stream_id = NEW.stream_id
    AND COALESCE(thread.parent_anchor_id, thread.parent_message_id) = NEW.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_legacy_message_thread_projection ON messages;
CREATE TRIGGER sync_legacy_message_thread_projection
AFTER UPDATE OF reply_count ON messages
FOR EACH ROW
WHEN (OLD.reply_count IS DISTINCT FROM NEW.reply_count)
EXECUTE FUNCTION sync_legacy_message_thread_projection();

-- Heal any drift accumulated between the substrate backfill and this projection
-- deployment before streams.reply_count becomes the live projection.
UPDATE streams AS thread
SET reply_count = anchor.reply_count,
    last_reply_at = (
      SELECT MAX(created_at)
      FROM messages
      WHERE stream_id = thread.id
        AND deleted_at IS NULL
    ),
    updated_at = NOW()
FROM messages AS anchor
WHERE thread.type = 'thread'
  AND thread.parent_stream_id = anchor.stream_id
  AND COALESCE(thread.parent_anchor_id, thread.parent_message_id) = anchor.id
  AND (
    thread.reply_count IS DISTINCT FROM anchor.reply_count
    OR thread.last_reply_at IS DISTINCT FROM (
      SELECT MAX(created_at)
      FROM messages
      WHERE stream_id = thread.id
        AND deleted_at IS NULL
    )
  );
