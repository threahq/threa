SET LOCAL lock_timeout = '5s';

ALTER TABLE conversations DROP CONSTRAINT conversations_pkey, ADD CONSTRAINT conversations_pkey PRIMARY KEY USING INDEX conversations_pkey_ws;
