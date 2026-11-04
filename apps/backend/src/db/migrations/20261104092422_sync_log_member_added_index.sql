-- Catch-up's join_bounds CTE reads a user's `stream:member_added` entries. Via
-- the GIN groups index that is a bitmap heap scan over every entry addressed to
-- the user (thousands of heap pages per call); these entries are a tiny
-- fraction of the log.
--
-- Standalone single-statement file so CONCURRENTLY works: the migration runner
-- runs a multi-statement file as one implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_log_member_added
  ON sync_log (workspace_id)
  WHERE event_type = 'stream:member_added';
