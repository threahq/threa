-- Enqueue the `ai-spending-policy-seed` backfill (INV-67). One plan job under
-- the `system` scope: it seeds `unprotected` for every workspace still missing a
-- policy, which catches workspaces an old-code replica created after
-- `20260916122642_ai_spending_policy_enrollment.sql` ran. The 15 minute delay
-- lets those replicas drain and new code register the definition first.

INSERT INTO queue_messages (id, queue_name, workspace_id, payload, process_after, inserted_at)
SELECT
    'queue_' || replace(gen_random_uuid()::text, '-', ''),
    'backfill.plan',
    'system',
    jsonb_build_object('workspaceId', 'system', 'backfillName', 'ai-spending-policy-seed'),
    NOW() + INTERVAL '15 minutes',
    NOW();
