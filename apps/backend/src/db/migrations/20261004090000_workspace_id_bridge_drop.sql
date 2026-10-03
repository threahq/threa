SET LOCAL lock_timeout = '5s';

DROP TRIGGER stream_members_workspace_id_bridge ON stream_members;
DROP TRIGGER stream_events_workspace_id_bridge ON stream_events;
DROP TRIGGER stream_persona_participants_workspace_id_bridge ON stream_persona_participants;
DROP TRIGGER message_versions_workspace_id_bridge ON message_versions;
DROP TRIGGER messages_workspace_id_bridge ON messages;
DROP TRIGGER agent_sessions_workspace_id_bridge ON agent_sessions;
DROP TRIGGER stream_sequences_workspace_id_bridge ON stream_sequences;
DROP TRIGGER agent_session_steps_workspace_id_bridge ON agent_session_steps;
DROP TRIGGER stream_persona_roster_workspace_id_bridge ON stream_persona_roster;
DROP TRIGGER user_preference_overrides_workspace_id_bridge ON user_preference_overrides;
DROP TRIGGER reactions_workspace_id_bridge ON reactions;

DROP FUNCTION workspace_id_from_stream();
DROP FUNCTION workspace_id_from_message();
DROP FUNCTION workspace_id_from_agent_session();
DROP FUNCTION workspace_id_from_user();
