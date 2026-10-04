SET LOCAL lock_timeout = '5s';

DROP INDEX idx_subagent_runs_one_active;
ALTER INDEX idx_subagent_runs_one_active_ws RENAME TO idx_subagent_runs_one_active;
