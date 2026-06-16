-- Index stream_events by (stream_id, created_at) for jump-to-date lookups.
-- The events table is otherwise indexed only on (stream_id, sequence); resolving
-- "first message on or after <instant>" (findFirstMessageOnOrAfter) needs an
-- ordered scan by created_at within a stream.

CREATE INDEX IF NOT EXISTS idx_stream_events_stream_created
    ON stream_events (stream_id, created_at);
