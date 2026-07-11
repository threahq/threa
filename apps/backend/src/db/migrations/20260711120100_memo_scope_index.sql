-- Owner index for the memo scope tier (roadmap 6.4), companion to
-- 20260711120000_memo_scope.sql. Drives the "About you" explorer filter and the
-- per-owner retrieval gate: both look up a user's own private-tier memos.
--
-- Standalone single-statement file so CONCURRENTLY works: the migration runner
-- executes each file as one `pool.query`, which for a multi-statement file is an
-- implicit transaction — and CREATE INDEX CONCURRENTLY cannot run inside one.
-- CONCURRENTLY avoids blocking writes to `memos` during the build (the existing
-- CONCURRENTLY index migrations follow the same one-statement-per-file shape).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memos_scope_user
  ON memos (workspace_id, scope_user_id)
  WHERE scope = 'user';
