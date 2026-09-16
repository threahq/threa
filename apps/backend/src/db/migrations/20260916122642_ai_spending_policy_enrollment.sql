-- AI spending enrollment: explicit policy status instead of an enabled flag.
--
-- `status` is unprotected | disabled | enforced (TEXT, validated in code, INV-3).
-- Limits are nullable because only an enforced policy needs them; code requires
-- all five, ordered, when enforcing. `coverage_profile` records the coverage the
-- operator acknowledged when enforcing.
--
-- Existing rows become `disabled`, never `enforced`: they predate coverage
-- acknowledgement, so enforcing them would claim an approval nobody gave.
-- Limits, version, latch and every period/attempt row are kept as they are.
--
-- Every workspace without a policy gets an explicit `unprotected` row with no
-- limits. A missing row always denies; workspaces an old replica creates after
-- this runs are seeded by the delayed `ai-spending-policy-seed` backfill.

ALTER TABLE ai_spending_policies
    ADD COLUMN status TEXT,
    ADD COLUMN coverage_profile TEXT,
    ADD COLUMN status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN status_changed_by TEXT,
    ADD COLUMN updated_by TEXT;

UPDATE ai_spending_policies SET status = 'disabled';

ALTER TABLE ai_spending_policies
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN agent_cutoff_usd DROP NOT NULL,
    ALTER COLUMN enrichment_cutoff_usd DROP NOT NULL,
    ALTER COLUMN core_cutoff_usd DROP NOT NULL,
    ALTER COLUMN embedding_cutoff_usd DROP NOT NULL,
    ALTER COLUMN operator_ceiling_usd DROP NOT NULL,
    DROP COLUMN enabled;

INSERT INTO ai_spending_policies (workspace_id, version, status)
SELECT id, 1, 'unprotected' FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;
