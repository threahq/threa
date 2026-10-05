-- Drives a shared channel's memo sync on both sides: the host's index of the
-- memos it captured while shared, and the partner's list of the copies it holds.
--
-- Standalone single-statement file so CONCURRENTLY works: the migration runner
-- runs a multi-statement file as one implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memos_shared_root
  ON memos (workspace_id, shared_root_stream_id)
  WHERE shared_root_stream_id IS NOT NULL;
