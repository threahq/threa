SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX stream_member_message_reads_pkey_ws ON stream_member_message_reads (workspace_id, stream_id, member_id, message_id);
