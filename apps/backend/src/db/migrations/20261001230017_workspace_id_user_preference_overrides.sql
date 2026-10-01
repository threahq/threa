-- The backfill UPDATE leaves (user_id, key, value) as they were, so
-- advance_user_preference_override_generation keeps every row's value_generation.
ALTER TABLE user_preference_overrides ADD COLUMN workspace_id TEXT;

CREATE TRIGGER user_preference_overrides_workspace_id_bridge
BEFORE INSERT ON user_preference_overrides
FOR EACH ROW
WHEN (NEW.workspace_id IS NULL)
EXECUTE FUNCTION workspace_id_from_user();

UPDATE user_preference_overrides t SET workspace_id = u.workspace_id FROM users u WHERE u.id = t.user_id;

ALTER TABLE user_preference_overrides ALTER COLUMN workspace_id SET NOT NULL;
