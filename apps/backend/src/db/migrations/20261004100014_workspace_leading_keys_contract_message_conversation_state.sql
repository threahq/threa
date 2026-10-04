SET LOCAL lock_timeout = '5s';

ALTER TABLE message_conversation_state DROP CONSTRAINT message_conversation_state_pkey, ADD CONSTRAINT message_conversation_state_pkey PRIMARY KEY USING INDEX message_conversation_state_pkey_ws;
