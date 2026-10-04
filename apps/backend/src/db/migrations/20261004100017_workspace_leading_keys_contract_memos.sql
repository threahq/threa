SET LOCAL lock_timeout = '5s';

ALTER TABLE memos DROP CONSTRAINT memos_pkey, ADD CONSTRAINT memos_pkey PRIMARY KEY USING INDEX memos_pkey_ws;
