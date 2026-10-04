SET LOCAL lock_timeout = '5s';

ALTER TABLE stream_read_state DROP CONSTRAINT stream_read_state_pkey, ADD CONSTRAINT stream_read_state_pkey PRIMARY KEY USING INDEX stream_read_state_pkey_ws;
