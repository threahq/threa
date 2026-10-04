SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX attachment_extractions_pkey_ws ON attachment_extractions (workspace_id, id);
CREATE UNIQUE INDEX attachment_extractions_attachment_id_key_ws ON attachment_extractions (workspace_id, attachment_id);
