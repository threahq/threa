SET LOCAL lock_timeout = '5s';

ALTER TABLE board_muted_streams DROP CONSTRAINT board_muted_streams_pkey, ADD CONSTRAINT board_muted_streams_pkey PRIMARY KEY USING INDEX board_muted_streams_pkey_ws;
