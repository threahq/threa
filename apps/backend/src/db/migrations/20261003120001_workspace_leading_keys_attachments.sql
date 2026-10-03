SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX attachments_pkey_ws ON attachments (workspace_id, id);
