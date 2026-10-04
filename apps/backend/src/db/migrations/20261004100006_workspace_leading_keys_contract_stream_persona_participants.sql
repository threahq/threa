SET LOCAL lock_timeout = '5s';

ALTER TABLE stream_persona_participants DROP CONSTRAINT stream_persona_participants_pkey, ADD CONSTRAINT stream_persona_participants_pkey PRIMARY KEY USING INDEX stream_persona_participants_pkey_ws;
