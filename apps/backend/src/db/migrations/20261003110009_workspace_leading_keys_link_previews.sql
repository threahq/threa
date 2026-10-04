SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX link_previews_pkey_ws ON link_previews (workspace_id, id);
