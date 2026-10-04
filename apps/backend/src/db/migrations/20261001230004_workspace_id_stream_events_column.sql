-- workspace_id on stream_events, in three files like messages: inside ADD
-- COLUMN's transaction the backfill would hold ACCESS EXCLUSIVE and stall old
-- replicas' timeline reads and message sends for its whole run.
ALTER TABLE stream_events ADD COLUMN workspace_id TEXT;

CREATE TRIGGER stream_events_workspace_id_bridge
BEFORE INSERT ON stream_events
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();
