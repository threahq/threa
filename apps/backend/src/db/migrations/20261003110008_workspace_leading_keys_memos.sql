SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX memos_pkey_ws ON memos (workspace_id, id);
