-- Phase 2.4b (E2EE-21): bind enclave session callbacks to the assigned runner.
--
-- callback_token: minted at dispatch, delivered only inside the session
-- assignment to the pinned EIK's instance, echoed on every callback —
-- possession proves the caller is the runner this session was assigned to.
-- NULL for non-enclave sessions and sessions dispatched before this deploy.
--
-- reply_key_generation: the SSK generation the assignment told the enclave to
-- seal under. Callbacks carrying a different generation are rejected loudly
-- instead of persisting a permanently undecryptable reply/step.

ALTER TABLE agent_sessions
ADD COLUMN IF NOT EXISTS callback_token TEXT;

ALTER TABLE agent_sessions
ADD COLUMN IF NOT EXISTS reply_key_generation INTEGER;
