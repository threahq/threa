SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX stream_events_pkey_ws ON stream_events (workspace_id, id);
CREATE UNIQUE INDEX stream_events_stream_id_sequence_key_ws ON stream_events (workspace_id, stream_id, sequence);
CREATE UNIQUE INDEX idx_stream_events_stream_broadcast_seq_ws ON stream_events (workspace_id, stream_id, broadcast_sequence) WHERE broadcast_sequence IS NOT NULL;
