SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX users_pkey_ws ON users (workspace_id, id);
