-- Claim idempotency for delegated tasks (roadmap 5.4 contract improvement).
-- A runner persists a random key BEFORE calling claim; if it crashes between
-- receiving the one-time claim token and persisting it, a retried claim
-- bearing the same key re-keys the claim (fresh token, fresh TTL) instead of
-- leaving the task stranded until expiry.
ALTER TABLE delegated_tasks ADD COLUMN claim_idempotency_key TEXT;
