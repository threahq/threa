SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX message_conversation_state_pkey_ws ON message_conversation_state (workspace_id, message_id);
