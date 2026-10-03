SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX idx_user_activity_dedup_non_reaction_ws ON user_activity (workspace_id, user_id, message_id, activity_type, actor_id) WHERE activity_type <> ALL (ARRAY['reaction'::text, 'saved_reminder'::text]);
CREATE UNIQUE INDEX idx_user_activity_dedup_reaction_ws ON user_activity (workspace_id, user_id, message_id, actor_id, emoji) WHERE activity_type = 'reaction';
