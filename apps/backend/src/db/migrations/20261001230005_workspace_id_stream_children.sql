-- workspace_id on the small streams children. agent_sessions is filled here so
-- agent_session_steps can follow it from its own file.
ALTER TABLE stream_members ADD COLUMN workspace_id TEXT;
ALTER TABLE stream_persona_participants ADD COLUMN workspace_id TEXT;
ALTER TABLE stream_persona_roster ADD COLUMN workspace_id TEXT;
ALTER TABLE stream_sequences ADD COLUMN workspace_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN workspace_id TEXT;

CREATE TRIGGER stream_members_workspace_id_bridge
BEFORE INSERT ON stream_members
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

CREATE TRIGGER stream_persona_participants_workspace_id_bridge
BEFORE INSERT ON stream_persona_participants
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

CREATE TRIGGER stream_persona_roster_workspace_id_bridge
BEFORE INSERT ON stream_persona_roster
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

CREATE TRIGGER stream_sequences_workspace_id_bridge
BEFORE INSERT ON stream_sequences
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

CREATE TRIGGER agent_sessions_workspace_id_bridge
BEFORE INSERT ON agent_sessions
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

UPDATE stream_members t SET workspace_id = s.workspace_id FROM streams s WHERE s.id = t.stream_id;
UPDATE stream_persona_participants t SET workspace_id = s.workspace_id FROM streams s WHERE s.id = t.stream_id;
UPDATE stream_persona_roster t SET workspace_id = s.workspace_id FROM streams s WHERE s.id = t.stream_id;
UPDATE stream_sequences t SET workspace_id = s.workspace_id FROM streams s WHERE s.id = t.stream_id;
UPDATE agent_sessions t SET workspace_id = s.workspace_id FROM streams s WHERE s.id = t.stream_id;

ALTER TABLE stream_members ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE stream_persona_participants ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE stream_persona_roster ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE stream_sequences ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE agent_sessions ALTER COLUMN workspace_id SET NOT NULL;
