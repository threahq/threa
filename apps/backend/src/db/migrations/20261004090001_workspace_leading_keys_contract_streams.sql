SET LOCAL lock_timeout = '5s';

ALTER TABLE streams DROP CONSTRAINT streams_pkey, ADD CONSTRAINT streams_pkey PRIMARY KEY USING INDEX streams_pkey_ws;

DROP INDEX idx_streams_thread_anchor_typed;
ALTER INDEX idx_streams_thread_anchor_typed_ws RENAME TO idx_streams_thread_anchor_typed;
