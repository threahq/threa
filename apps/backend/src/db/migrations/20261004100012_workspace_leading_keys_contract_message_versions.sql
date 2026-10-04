SET LOCAL lock_timeout = '5s';

ALTER TABLE message_versions DROP CONSTRAINT message_versions_pkey, ADD CONSTRAINT message_versions_pkey PRIMARY KEY USING INDEX message_versions_pkey_ws;

DROP INDEX idx_message_versions_message_seq;
ALTER INDEX idx_message_versions_message_seq_ws RENAME TO idx_message_versions_message_seq;
