-- workspace_id on agent_session_steps, the largest table in the rollout, in
-- three files like messages so the backfill never holds ACCESS EXCLUSIVE.
ALTER TABLE agent_session_steps ADD COLUMN workspace_id TEXT;

CREATE TRIGGER agent_session_steps_workspace_id_bridge
BEFORE INSERT ON agent_session_steps
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_agent_session();
