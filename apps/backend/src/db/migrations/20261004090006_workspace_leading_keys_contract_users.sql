SET LOCAL lock_timeout = '5s';

ALTER TABLE users DROP CONSTRAINT users_pkey, ADD CONSTRAINT users_pkey PRIMARY KEY USING INDEX users_pkey_ws;

ALTER TABLE users DROP CONSTRAINT users_id_key;
