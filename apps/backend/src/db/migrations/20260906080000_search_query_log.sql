-- Opt-in search query log (feature flag `searchQueryLog`, off by default): one
-- row per message-search request by a consenting user, updated with the result
-- they opened. Seeds a retrieval eval set, so rows are kept, not pruned.
CREATE TABLE search_query_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  query TEXT NOT NULL,
  -- The request minus the query: phrases, filters, exact, limit.
  params JSONB NOT NULL,
  -- 'normal' | 'deep' — what the user asked for.
  mode TEXT NOT NULL,
  -- 'legacy' | 'improved' — the ranking the `search` flag resolved to.
  ranking TEXT NOT NULL,
  -- { messages: [...], conversations: [...] } in returned order.
  result_ids JSONB NOT NULL,
  clicked_kind TEXT,
  clicked_id TEXT,
  clicked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_search_query_log_workspace_created
  ON search_query_log (workspace_id, created_at DESC);
