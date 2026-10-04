SET LOCAL lock_timeout = '5s';

ALTER TABLE message_compose_traces DROP CONSTRAINT message_compose_traces_pkey, ADD CONSTRAINT message_compose_traces_pkey PRIMARY KEY USING INDEX message_compose_traces_pkey_ws;
