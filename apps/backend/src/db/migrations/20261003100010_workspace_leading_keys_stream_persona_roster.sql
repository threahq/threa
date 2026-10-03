SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX stream_persona_roster_pkey_ws ON stream_persona_roster (workspace_id, stream_id, persona_id);
