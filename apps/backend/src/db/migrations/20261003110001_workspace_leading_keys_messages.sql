SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX messages_pkey_ws ON messages (workspace_id, id);
CREATE UNIQUE INDEX messages_stream_id_client_message_id_unique_ws ON messages (workspace_id, stream_id, client_message_id) WHERE client_message_id IS NOT NULL;
