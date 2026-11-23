-- The model a session's latest failed attempt ran when it failed on a model
-- provider error; NULL otherwise. The next attempt runs the fallback model.

ALTER TABLE agent_sessions
ADD COLUMN IF NOT EXISTS provider_failed_model TEXT;
