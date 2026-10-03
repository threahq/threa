SET LOCAL lock_timeout = '5s';

ALTER TABLE messages DROP CONSTRAINT messages_pkey, ADD CONSTRAINT messages_pkey PRIMARY KEY USING INDEX messages_pkey_ws;

DROP INDEX messages_stream_id_client_message_id_unique;
ALTER INDEX messages_stream_id_client_message_id_unique_ws RENAME TO messages_stream_id_client_message_id_unique;
