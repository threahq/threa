-- One table per file: a file locking several tables can deadlock against an
-- old replica's transaction that takes the same locks in another order.
ALTER TABLE stream_members ADD COLUMN workspace_id TEXT;

CREATE TRIGGER stream_members_workspace_id_bridge
BEFORE INSERT ON stream_members
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();

UPDATE stream_members t SET workspace_id = s.workspace_id FROM streams s WHERE s.id = t.stream_id;

ALTER TABLE stream_members ALTER COLUMN workspace_id SET NOT NULL;
