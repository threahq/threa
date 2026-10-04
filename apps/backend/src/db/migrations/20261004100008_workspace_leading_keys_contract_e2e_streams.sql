SET LOCAL lock_timeout = '5s';

ALTER TABLE e2e_streams DROP CONSTRAINT e2e_streams_pkey, ADD CONSTRAINT e2e_streams_pkey PRIMARY KEY USING INDEX e2e_streams_pkey_ws;
