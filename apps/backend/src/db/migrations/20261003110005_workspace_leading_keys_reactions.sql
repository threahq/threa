SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX reactions_pkey_ws ON reactions (workspace_id, message_id, user_id, emoji);
