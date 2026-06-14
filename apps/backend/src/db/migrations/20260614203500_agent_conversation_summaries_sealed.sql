-- =============================================================================
-- Sealed rolling summaries for E2E (enclave) agent context
-- =============================================================================
-- Generalizes agent_conversation_summaries to carry an E2E-sealed rolling
-- summary alongside the existing plaintext one. The companion/plaintext path
-- keeps writing the plaintext `summary` (backend can read those messages); the
-- enclave path computes its rolling summary in-enclave on decrypted content and
-- ships back ciphertext the regional backend can never open (the no-memory
-- guarantee, INV-E1). One row per (stream, persona) either way — the existing
-- uniqueness and the `last_summarized_sequence` cursor are shared, since the
-- sequence is cleartext metadata the enclave reports back.
--
-- Exactly one representation is populated per row, enforced in application code
-- (no DB CHECK, matching the no-FK / validate-in-code convention, INV-3):
--   - companion row: summary IS NOT NULL, sealed trio IS NULL
--   - enclave row:   summary IS NULL,     sealed trio IS NOT NULL
-- so `summary` can no longer be NOT NULL.

ALTER TABLE agent_conversation_summaries
    ADD COLUMN IF NOT EXISTS summary_ciphertext BYTEA,
    ADD COLUMN IF NOT EXISTS summary_envelope JSONB,
    ADD COLUMN IF NOT EXISTS key_generation INTEGER;

ALTER TABLE agent_conversation_summaries
    ALTER COLUMN summary DROP NOT NULL;
