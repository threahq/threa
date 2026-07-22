-- One anchor per (parent stream, anchor). Standalone so PostgreSQL can build
-- the index concurrently without blocking writes to streams.
CREATE UNIQUE INDEX CONCURRENTLY idx_streams_thread_anchor
ON streams (parent_stream_id, parent_anchor_id)
WHERE parent_anchor_id IS NOT NULL;
