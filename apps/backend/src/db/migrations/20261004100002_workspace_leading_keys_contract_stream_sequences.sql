SET LOCAL lock_timeout = '5s';

ALTER TABLE stream_sequences DROP CONSTRAINT stream_sequences_pkey, ADD CONSTRAINT stream_sequences_pkey PRIMARY KEY USING INDEX stream_sequences_pkey_ws;
