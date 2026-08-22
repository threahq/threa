-- Drop the untyped anchor uniqueness index now that the thread-scoped
-- idx_streams_thread_anchor_typed is live and every deployed replica's
-- ON CONFLICT names the typed predicate (stack final layer; see PR1).
-- Guard: never drop the only arbiter — a CONCURRENTLY build that failed
-- leaves the typed index invalid, and dropping the untyped one then would
-- strand insertThreadOrFind with no matching ON CONFLICT index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_streams_thread_anchor_typed'
      AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'idx_streams_thread_anchor_typed is missing or invalid; refusing to drop idx_streams_thread_anchor';
  END IF;
END
$$;

-- Non-CONCURRENT on purpose: this file runs as one implicit transaction
-- (multi-statement migration), where DROP INDEX CONCURRENTLY is illegal;
-- an index drop is metadata-fast.
DROP INDEX IF EXISTS idx_streams_thread_anchor;
