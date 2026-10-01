-- workspace_id on the children of messages. messages gained the column in an
-- earlier file, so both tables fill from it.
ALTER TABLE message_versions ADD COLUMN workspace_id TEXT;
ALTER TABLE reactions ADD COLUMN workspace_id TEXT;

CREATE TRIGGER message_versions_workspace_id_bridge
BEFORE INSERT ON message_versions
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_message();

CREATE TRIGGER reactions_workspace_id_bridge
BEFORE INSERT ON reactions
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_message();

UPDATE message_versions t SET workspace_id = m.workspace_id FROM messages m WHERE m.id = t.message_id;
UPDATE reactions t SET workspace_id = m.workspace_id FROM messages m WHERE m.id = t.message_id;

ALTER TABLE message_versions ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE reactions ALTER COLUMN workspace_id SET NOT NULL;
