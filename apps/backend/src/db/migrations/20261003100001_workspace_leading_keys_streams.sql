SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX streams_pkey_ws ON streams (workspace_id, id);
CREATE UNIQUE INDEX idx_streams_thread_anchor_typed_ws ON streams (workspace_id, parent_stream_id, parent_anchor_id) WHERE parent_anchor_id IS NOT NULL AND type = 'thread';
