-- =============================================================================
-- Encrypted trace-step content for E2E (enclave) agent sessions
-- =============================================================================
-- An enclave runs Ariadne's loop next to decrypted plaintext and ships back
-- trace steps the server must never be able to read (INV-E7). For those rows
-- the plaintext `content` column stays NULL; the step's sensitive content
-- (reasoning text, message body, …) is sealed under the stream's SSK and stored
-- as ciphertext + its envelope, decrypted only in the browser. Both columns are
-- nullable: in-process (plaintext-persona) steps keep using `content` and leave
-- these NULL.

ALTER TABLE agent_session_steps
    ADD COLUMN content_ciphertext TEXT;

ALTER TABLE agent_session_steps
    ADD COLUMN content_envelope JSONB;
