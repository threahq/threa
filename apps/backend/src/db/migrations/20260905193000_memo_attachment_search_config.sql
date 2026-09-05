-- The config cast now stems memos and attachment extractions too, so it is no
-- longer message-specific. Renaming keeps the messages generated column intact:
-- its stored expression references the function by oid, not by name.
ALTER FUNCTION message_search_config(TEXT) RENAME TO text_search_config;

-- Which Postgres text-search config stems this memo, detected from its title,
-- abstract and key points on write. NULL means the row predates the column;
-- the memo-search-config backfill fills it. Memo full-text search computes its
-- tsvector per row (no stored column, no index), so this drives both the
-- vector and the tsquery the memo repository parses.
ALTER TABLE memos ADD COLUMN search_config TEXT;

-- Same for an attachment's extracted text (summary + full text). The
-- attachments table's own search_vector is filename-only in practice, so it
-- keeps stemming as English.
ALTER TABLE attachment_extractions ADD COLUMN search_config TEXT;

-- Rewrites attachment_extractions under ACCESS EXCLUSIVE and rebuilds its
-- indexes, including a 7 MB HNSW. Build serially: a parallel HNSW rebuild asks
-- for a maintenance_work_mem-sized shared-memory segment, which prod's
-- /dev/shm cannot hold (SQLSTATE 53100, the #2037 crash loop).
SET LOCAL max_parallel_maintenance_workers = 0;
ALTER TABLE attachment_extractions ALTER COLUMN search_vector
  SET EXPRESSION AS (
    to_tsvector(text_search_config(search_config), COALESCE(summary, '') || ' ' || COALESCE(full_text, ''))
  );

-- SET EXPRESSION drops the column's planner statistics.
ANALYZE attachment_extractions;
