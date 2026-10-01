ALTER TABLE agent_sessions ADD COLUMN workspace_id TEXT;

CREATE TRIGGER agent_sessions_workspace_id_bridge
BEFORE INSERT ON agent_sessions
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

UPDATE agent_sessions t SET workspace_id = s.workspace_id FROM streams s WHERE s.id = t.stream_id;

ALTER TABLE agent_sessions ALTER COLUMN workspace_id SET NOT NULL;
