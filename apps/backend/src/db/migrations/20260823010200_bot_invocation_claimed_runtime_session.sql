ALTER TABLE bot_invocations
ADD COLUMN claimed_runtime_session_id TEXT,
ADD COLUMN claimed_runtime_session_claim_token TEXT;
