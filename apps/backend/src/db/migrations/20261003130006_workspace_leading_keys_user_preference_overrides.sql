SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX user_preference_overrides_pkey_ws ON user_preference_overrides (workspace_id, user_id, key);
