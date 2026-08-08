-- Persist the runtime session that actually owns each claimed invocation.
ALTER TABLE bot_invocations
ADD COLUMN IF NOT EXISTS claimed_runtime_session_id TEXT;
