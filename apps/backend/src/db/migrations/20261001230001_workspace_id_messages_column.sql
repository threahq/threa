-- workspace_id on messages, in three files because the backfill is slow: the
-- UPDATE re-indexes every row with an embedding into the HNSW index (about 90s
-- on a prod-sized copy). Run inside ADD COLUMN's transaction it would hold
-- ACCESS EXCLUSIVE on messages for that long. Split, the column and trigger
-- commit in milliseconds, the backfill blocks nothing but writers of the rows
-- it has reached, and SET NOT NULL is a short scan.
ALTER TABLE messages ADD COLUMN workspace_id TEXT;

CREATE TRIGGER messages_workspace_id_bridge
BEFORE INSERT ON messages
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_stream();
