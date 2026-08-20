-- Drop the untyped anchor uniqueness index now that the thread-scoped
-- idx_streams_thread_anchor_typed exists; keeping it would 500 a second aside
-- on the same anchor. Standalone: DROP INDEX CONCURRENTLY cannot run inside a
-- transaction block.
DROP INDEX CONCURRENTLY IF EXISTS idx_streams_thread_anchor;
