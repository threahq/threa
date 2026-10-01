ALTER TABLE reactions ADD COLUMN workspace_id TEXT;

CREATE TRIGGER reactions_workspace_id_bridge
BEFORE INSERT ON reactions
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_message();

UPDATE reactions t SET workspace_id = m.workspace_id FROM messages m WHERE m.id = t.message_id;

ALTER TABLE reactions ALTER COLUMN workspace_id SET NOT NULL;
