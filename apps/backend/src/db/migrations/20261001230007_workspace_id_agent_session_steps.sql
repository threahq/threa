-- workspace_id on agent_session_steps, in its own file: the largest table in
-- the rollout, filled from agent_sessions (which gained the column earlier).
ALTER TABLE agent_session_steps ADD COLUMN workspace_id TEXT;

CREATE TRIGGER agent_session_steps_workspace_id_bridge
BEFORE INSERT ON agent_session_steps
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_agent_session();

UPDATE agent_session_steps t SET workspace_id = a.workspace_id FROM agent_sessions a WHERE a.id = t.session_id;

ALTER TABLE agent_session_steps ALTER COLUMN workspace_id SET NOT NULL;
