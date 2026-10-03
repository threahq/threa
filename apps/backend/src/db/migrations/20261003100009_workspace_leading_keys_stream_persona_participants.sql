SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX stream_persona_participants_pkey_ws ON stream_persona_participants (workspace_id, stream_id, persona_id);
