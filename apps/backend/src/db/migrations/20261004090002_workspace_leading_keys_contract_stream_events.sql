SET LOCAL lock_timeout = '5s';

ALTER TABLE stream_events DROP CONSTRAINT stream_events_pkey, ADD CONSTRAINT stream_events_pkey PRIMARY KEY USING INDEX stream_events_pkey_ws;

ALTER TABLE stream_events DROP CONSTRAINT stream_events_stream_id_sequence_key, ADD CONSTRAINT stream_events_stream_id_sequence_key UNIQUE USING INDEX stream_events_stream_id_sequence_key_ws;

DROP INDEX idx_stream_events_stream_broadcast_seq;
ALTER INDEX idx_stream_events_stream_broadcast_seq_ws RENAME TO idx_stream_events_stream_broadcast_seq;
