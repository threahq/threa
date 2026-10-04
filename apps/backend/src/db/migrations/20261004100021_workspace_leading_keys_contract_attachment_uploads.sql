SET LOCAL lock_timeout = '5s';

ALTER TABLE attachment_uploads DROP CONSTRAINT attachment_uploads_attachment_id_key, ADD CONSTRAINT attachment_uploads_attachment_id_key UNIQUE USING INDEX attachment_uploads_attachment_id_key_ws;
