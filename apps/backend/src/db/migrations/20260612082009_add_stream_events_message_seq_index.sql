-- Partial index for message-ordinal counts (sync-v2 phase 2c).
-- countMessagesThrough / getMessageOrdinalForEvent / countUnreadByStreamBatch
-- count message_created rows by (stream_id, sequence) range. The generic
-- idx_stream_events_stream_seq covers (stream_id, sequence) but not the
-- event_type filter, so every count would post-filter non-message events.
-- The partial index makes the count an index-only range scan, which matters
-- because countMessagesThrough runs inside every message-send transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stream_events_message_seq
  ON stream_events (stream_id, sequence)
  WHERE event_type = 'message_created';
