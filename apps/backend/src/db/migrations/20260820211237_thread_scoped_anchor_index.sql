-- Thread-scoped replacement for idx_streams_thread_anchor: anchor uniqueness is
-- a THREAD invariant only — asides share anchors freely. Standalone so
-- PostgreSQL can build the index concurrently without blocking writes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_streams_thread_anchor_typed
ON streams (parent_stream_id, parent_anchor_id)
WHERE parent_anchor_id IS NOT NULL AND type = 'thread';
