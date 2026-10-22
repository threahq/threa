SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX idx_agent_sessions_one_running_per_actor ON agent_sessions (workspace_id, stream_id, persona_id) WHERE status = 'running';
DROP INDEX idx_agent_sessions_one_running_per_stream;
