SET LOCAL lock_timeout = '5s';

ALTER TABLE user_preference_overrides DROP CONSTRAINT user_preference_overrides_pkey, ADD CONSTRAINT user_preference_overrides_pkey PRIMARY KEY USING INDEX user_preference_overrides_pkey_ws;
