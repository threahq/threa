SET LOCAL lock_timeout = '5s';

DROP INDEX idx_agent_sessions_one_running_per_stream;
ALTER INDEX idx_agent_sessions_one_running_per_stream_ws RENAME TO idx_agent_sessions_one_running_per_stream;
