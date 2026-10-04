SET LOCAL lock_timeout = '5s';

ALTER TABLE link_previews DROP CONSTRAINT link_previews_pkey, ADD CONSTRAINT link_previews_pkey PRIMARY KEY USING INDEX link_previews_pkey_ws;
