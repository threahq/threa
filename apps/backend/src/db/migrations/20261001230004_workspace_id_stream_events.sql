-- workspace_id on stream_events, in its own file to bound the ACCESS EXCLUSIVE
-- hold. See workspace_id_bridge_functions for the insert trigger.
ALTER TABLE stream_events ADD COLUMN workspace_id TEXT;

CREATE TRIGGER stream_events_workspace_id_bridge
BEFORE INSERT ON stream_events
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

UPDATE stream_events e SET workspace_id = s.workspace_id FROM streams s WHERE s.id = e.stream_id;

ALTER TABLE stream_events ALTER COLUMN workspace_id SET NOT NULL;
