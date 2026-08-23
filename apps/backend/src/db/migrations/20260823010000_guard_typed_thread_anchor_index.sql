-- Guard for the drop that follows: never remove the untyped anchor index while
-- the typed replacement is missing or invalid (a CONCURRENTLY build that failed
-- leaves an invalid index behind), which would strand insertThreadOrFind with
-- no ON CONFLICT arbiter. Separate from the drop so the drop can run as a
-- single statement, i.e. CONCURRENTLY.
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
