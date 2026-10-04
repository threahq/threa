SET LOCAL lock_timeout = '5s';

ALTER TABLE persona_attachments DROP CONSTRAINT persona_attachments_pkey, ADD CONSTRAINT persona_attachments_pkey PRIMARY KEY USING INDEX persona_attachments_pkey_ws;
