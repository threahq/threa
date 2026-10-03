SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX idx_subagent_runs_one_active_ws ON subagent_runs (workspace_id, scope_stream_id) WHERE status = 'active';
