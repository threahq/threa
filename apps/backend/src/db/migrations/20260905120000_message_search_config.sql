-- Which Postgres text-search config stems this message's search_vector
-- ('swedish', 'german', ...), detected from the body on write. NULL means the
-- row predates the column; the message-search-config backfill fills it.
ALTER TABLE messages ADD COLUMN search_config TEXT;

-- text → regconfig is only STABLE and a generated column needs IMMUTABLE;
-- pinning the name to pg_catalog keeps the result independent of search_path.
-- NULL stems as English, which is what every row got before this migration.
CREATE FUNCTION message_search_config(name TEXT) RETURNS regconfig
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ('pg_catalog.' || COALESCE(name, 'english'))::regconfig
$$;

-- Rewrites messages under ACCESS EXCLUSIVE and rebuilds its indexes. A parallel
-- HNSW rebuild asks for a maintenance_work_mem-sized shared-memory segment,
-- which prod's /dev/shm cannot hold (SQLSTATE 53100 on the first deploy), so
-- build serially; the serial build keeps the graph in local memory, and 256 MB
-- fits the 286 MB index's graph where the default 64 MB spills and builds slow.
SET LOCAL max_parallel_maintenance_workers = 0;
SET LOCAL maintenance_work_mem = '256MB';
ALTER TABLE messages ALTER COLUMN search_vector
  SET EXPRESSION AS (to_tsvector(message_search_config(search_config), content_markdown));
