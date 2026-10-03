SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX attachment_uploads_attachment_id_key_ws ON attachment_uploads (workspace_id, attachment_id);
