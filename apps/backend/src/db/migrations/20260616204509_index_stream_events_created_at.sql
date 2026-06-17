-- Index stream_events by (stream_id, created_at) for jump-to-date lookups.
-- The events table is otherwise indexed only on (stream_id, sequence); resolving
-- "first message on or after <instant>" (findFirstMessageOnOrAfter) needs an
-- ordered scan by created_at within a stream.
--
-- CONCURRENTLY so the build doesn't take a write-blocking lock on a hot table
-- (matches the prior stream_events index migrations; the migration runner runs
-- each file outside a transaction, so CONCURRENTLY is allowed). Partial on the
-- two message event types the lookup filters by, mirroring idx_stream_events_message_seq.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stream_events_stream_created
    ON stream_events (stream_id, created_at)
    WHERE event_type IN ('message_created', 'companion_response');
