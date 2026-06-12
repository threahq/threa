-- Phase 2.4b (E2EE-21): bind enclave session callbacks to the assigned runner.
--
-- callback_token_hash: sha256 of the token minted at dispatch. The CLEARTEXT
-- token is delivered only inside the session assignment to the pinned EIK's
-- instance and echoed on every callback — possession proves the caller is the
-- runner this session was assigned to. Only the digest is persisted (same
-- at-rest discipline as bot API keys), so a database read can never yield a
-- value that impersonates the runner. NULL for non-enclave sessions and
-- sessions dispatched before this deploy.
--
-- reply_key_generation: the SSK generation the assignment told the enclave to
-- seal under. Callbacks carrying a different generation are rejected loudly
-- instead of persisting a permanently undecryptable reply/step.

ALTER TABLE agent_sessions
ADD COLUMN IF NOT EXISTS callback_token_hash TEXT;

ALTER TABLE agent_sessions
ADD COLUMN IF NOT EXISTS reply_key_generation INTEGER;
