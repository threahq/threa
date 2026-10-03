SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX e2e_streams_pkey_ws ON e2e_streams (workspace_id, stream_id);
