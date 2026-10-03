SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX persona_attachments_pkey_ws ON persona_attachments (workspace_id, attachment_id);
