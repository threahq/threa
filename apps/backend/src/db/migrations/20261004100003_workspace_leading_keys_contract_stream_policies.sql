SET LOCAL lock_timeout = '5s';

ALTER TABLE stream_policies DROP CONSTRAINT stream_policies_pkey, ADD CONSTRAINT stream_policies_pkey PRIMARY KEY USING INDEX stream_policies_pkey_ws;
