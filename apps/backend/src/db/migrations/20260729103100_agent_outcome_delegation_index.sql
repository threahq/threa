-- Keyset scan for the delegation branch of the cross-stream agent-outcomes read,
-- companion to 20260729103000_agent_outcome_indexes.sql. That branch orders on
-- `status_changed_at` — a delegation's last transition — with `id` as the
-- tiebreaker the cursor compares on. Single-statement file for CONCURRENTLY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delegated_tasks_workspace_status_changed
  ON delegated_tasks (workspace_id, status_changed_at DESC, id DESC);
