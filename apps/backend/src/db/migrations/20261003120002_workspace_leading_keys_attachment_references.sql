SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX attachment_references_pkey_ws ON attachment_references (workspace_id, id);
CREATE UNIQUE INDEX attachment_references_pair_idx_ws ON attachment_references (workspace_id, attachment_id, message_id);
