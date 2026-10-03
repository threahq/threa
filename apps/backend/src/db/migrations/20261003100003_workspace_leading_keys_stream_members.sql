SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX stream_members_pkey_ws ON stream_members (workspace_id, stream_id, member_id);
