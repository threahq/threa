SET LOCAL lock_timeout = '5s';

ALTER TABLE board_hidden_conversations DROP CONSTRAINT board_hidden_conversations_pkey, ADD CONSTRAINT board_hidden_conversations_pkey PRIMARY KEY USING INDEX board_hidden_conversations_pkey_ws;
