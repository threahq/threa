-- Standalone so PostgreSQL can drop the legacy index concurrently instead of
-- blocking reads and writes on streams while removing it.
DROP INDEX CONCURRENTLY IF EXISTS idx_streams_thread_parent;
