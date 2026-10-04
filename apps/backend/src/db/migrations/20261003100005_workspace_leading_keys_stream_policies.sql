SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX stream_policies_pkey_ws ON stream_policies (workspace_id, stream_id);
