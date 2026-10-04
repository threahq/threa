SET LOCAL lock_timeout = '5s';

ALTER TABLE stream_members DROP CONSTRAINT stream_members_pkey, ADD CONSTRAINT stream_members_pkey PRIMARY KEY USING INDEX stream_members_pkey_ws;
