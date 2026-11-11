-- The favicon route asks which previews sit on a host: a prefix match on
-- normalized_url. The unique index cannot serve LIKE under a non-C collation;
-- text_pattern_ops can.
--
-- Standalone single-statement file so CONCURRENTLY works: the migration runner
-- runs a multi-statement file as one implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_link_previews_ws_url_prefix
  ON link_previews (workspace_id, normalized_url text_pattern_ops);
