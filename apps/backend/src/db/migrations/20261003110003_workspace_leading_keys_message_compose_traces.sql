SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX message_compose_traces_pkey_ws ON message_compose_traces (workspace_id, message_id);
