SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX researcher_cache_message_id_key_ws ON researcher_cache (workspace_id, message_id);
