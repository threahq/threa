SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX conversations_pkey_ws ON conversations (workspace_id, id);
