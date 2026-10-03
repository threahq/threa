SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX stream_sequences_pkey_ws ON stream_sequences (workspace_id, stream_id);
