SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX board_muted_streams_pkey_ws ON board_muted_streams (workspace_id, stream_id, user_id);
