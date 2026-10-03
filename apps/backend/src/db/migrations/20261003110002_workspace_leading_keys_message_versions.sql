SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX message_versions_pkey_ws ON message_versions (workspace_id, id);
CREATE UNIQUE INDEX idx_message_versions_message_seq_ws ON message_versions (workspace_id, message_id, version_number);
