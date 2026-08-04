-- Keyset scan for the follow-up branch of the cross-stream agent-outcomes read
-- (GET /api/workspaces/:workspaceId/agent-outcomes). That branch orders on
-- `scheduled_for` — a follow-up's firing time — so it needs a workspace-scoped
-- DESC index with `id` as the tiebreaker the cursor compares on.
--
-- Standalone single-statement file so CONCURRENTLY works: the migration runner
-- executes each file as one `pool.query`, which for a multi-statement file is an
-- implicit transaction — and CREATE INDEX CONCURRENTLY cannot run inside one.
-- The delegation branch's index is the companion 20260729103100 migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_follow_ups_workspace_scheduled
  ON agent_follow_ups (workspace_id, scheduled_for DESC, id DESC);
