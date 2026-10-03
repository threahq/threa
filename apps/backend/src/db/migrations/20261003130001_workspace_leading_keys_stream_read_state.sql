SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX stream_read_state_pkey_ws ON stream_read_state (workspace_id, stream_id, user_id);
