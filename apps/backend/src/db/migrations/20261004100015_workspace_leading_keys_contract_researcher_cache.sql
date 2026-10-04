SET LOCAL lock_timeout = '5s';

ALTER TABLE researcher_cache DROP CONSTRAINT researcher_cache_message_id_key, ADD CONSTRAINT researcher_cache_message_id_key UNIQUE USING INDEX researcher_cache_message_id_key_ws;
