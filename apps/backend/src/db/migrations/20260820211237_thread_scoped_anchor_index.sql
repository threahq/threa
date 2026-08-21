-- Thread-scoped replacement for idx_streams_thread_anchor: anchor uniqueness is
-- a THREAD invariant only. The untyped index is dropped by a later migration
-- (after every replica names this index as its ON CONFLICT arbiter); until
-- then it still rejects a second stream of any type on one anchor, so asides
-- cannot yet share an anchor. Standalone so PostgreSQL can build the index
-- concurrently without blocking writes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_streams_thread_anchor_typed
ON streams (parent_stream_id, parent_anchor_id)
WHERE parent_anchor_id IS NOT NULL AND type = 'thread';
