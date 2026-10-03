SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX board_hidden_conversations_pkey_ws ON board_hidden_conversations (workspace_id, conversation_id, user_id);
