SET LOCAL lock_timeout = '5s';

ALTER TABLE reactions DROP CONSTRAINT reactions_pkey, ADD CONSTRAINT reactions_pkey PRIMARY KEY USING INDEX reactions_pkey_ws;
