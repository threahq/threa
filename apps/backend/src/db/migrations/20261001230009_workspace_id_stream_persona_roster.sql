ALTER TABLE stream_persona_roster ADD COLUMN workspace_id TEXT;

CREATE TRIGGER stream_persona_roster_workspace_id_bridge
BEFORE INSERT ON stream_persona_roster
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

UPDATE stream_persona_roster t SET workspace_id = s.workspace_id FROM streams s WHERE s.id = t.stream_id;

ALTER TABLE stream_persona_roster ALTER COLUMN workspace_id SET NOT NULL;
