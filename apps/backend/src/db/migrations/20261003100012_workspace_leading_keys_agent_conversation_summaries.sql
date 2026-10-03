SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX idx_agent_conversation_summaries_stream_persona_ws ON agent_conversation_summaries (workspace_id, stream_id, persona_id);
