-- Standalone so PostgreSQL can drop the untyped index concurrently instead of
-- holding ACCESS EXCLUSIVE on streams. Anchor uniqueness is a THREAD invariant
-- only from here on; the typed index (guarded by the migration before this one)
-- is the arbiter every deployed replica names.
DROP INDEX CONCURRENTLY IF EXISTS idx_streams_thread_anchor;
