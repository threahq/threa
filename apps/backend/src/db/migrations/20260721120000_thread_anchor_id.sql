-- Event-anchored threads (substrate): unify the thread anchor onto ONE column.
--
-- A thread anchors on the canonical id of the timeline item it hangs under:
-- `msg_…` for a message, `event_…` for a card. `parent_anchor_id` replaces
-- `parent_message_id` as the anchor track; the legacy column and its index stay
-- through the grace period (dropped in the cleanup chunk). Reply stats move onto
-- the thread stream row so every anchor kind shares one projection.

ALTER TABLE streams ADD COLUMN parent_anchor_id TEXT;
ALTER TABLE streams ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE streams ADD COLUMN last_reply_at TIMESTAMPTZ;

-- Backfill the anchor from the legacy column for every existing thread. All
-- pre-feature threads are message-anchored, so the anchor is the message id.
UPDATE streams
SET parent_anchor_id = parent_message_id
WHERE type = 'thread' AND parent_message_id IS NOT NULL;

-- Backfill reply stats from each thread stream's own non-deleted messages
-- (the thread IS the stream its replies land in). Threads with no live replies
-- keep the column default of 0 / NULL.
UPDATE streams s
SET reply_count = stats.reply_count,
    last_reply_at = stats.last_reply_at
FROM (
  SELECT stream_id,
         COUNT(*) AS reply_count,
         MAX(created_at) AS last_reply_at
  FROM messages
  WHERE deleted_at IS NULL
  GROUP BY stream_id
) stats
WHERE s.id = stats.stream_id AND s.type = 'thread';

-- The companion migration builds the unique anchor index concurrently after
-- this backfill. The legacy idx_streams_thread_parent stays until cleanup.
