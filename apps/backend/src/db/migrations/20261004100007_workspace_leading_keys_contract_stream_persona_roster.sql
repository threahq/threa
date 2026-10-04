SET LOCAL lock_timeout = '5s';

ALTER TABLE stream_persona_roster DROP CONSTRAINT stream_persona_roster_pkey, ADD CONSTRAINT stream_persona_roster_pkey PRIMARY KEY USING INDEX stream_persona_roster_pkey_ws;
