UPDATE agent_session_steps t SET workspace_id = a.workspace_id FROM agent_sessions a WHERE a.id = t.session_id;
