-- The canonical anchor and thread-row reply stats are authoritative after the
-- cleanup reconciler and concurrent legacy-index drop.
ALTER TABLE streams DROP COLUMN parent_message_id;

-- Reply stats now live on the thread stream row (streams.reply_count); the
-- message wire `replyCount` derives via join on parent_anchor_id.
ALTER TABLE messages DROP COLUMN reply_count;

-- The scheduled-message parent is semantically a thread anchor id (msg_…), not a
-- distinct "parent message" concept — rename the column to match.
ALTER TABLE scheduled_messages RENAME COLUMN parent_message_id TO parent_anchor_id;
