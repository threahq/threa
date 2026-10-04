SET LOCAL lock_timeout = '5s';

ALTER TABLE attachments DROP CONSTRAINT attachments_pkey, ADD CONSTRAINT attachments_pkey PRIMARY KEY USING INDEX attachments_pkey_ws;
