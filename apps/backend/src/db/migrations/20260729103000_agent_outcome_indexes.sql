-- Keyset scans for the cross-stream agent-outcomes read
-- (GET /api/workspaces/:workspaceId/agent-outcomes). Each branch of the UNION
-- orders on its own `occurs_at` column — `scheduled_for` for a follow-up (its
-- firing time), `status_changed_at` for a delegation (its last transition) —
-- so both need a workspace-scoped DESC index with `id` as the tiebreaker the
-- cursor compares on.

CREATE INDEX IF NOT EXISTS idx_agent_follow_ups_workspace_scheduled
  ON agent_follow_ups (workspace_id, scheduled_for DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_delegated_tasks_workspace_status_changed
  ON delegated_tasks (workspace_id, status_changed_at DESC, id DESC);
