-- =============================================================================
-- Backfill: "In this stream" pull request rows
-- =============================================================================
--
-- The write path now projects every URL into a GitHub pull request as a
-- `pull_request` row instead of a `link` row. Re-enqueue the SAME
-- `stream-context-index` definition per workspace: each messages chunk inserts
-- the new rows (`ON CONFLICT DO NOTHING` on the identity index, so nothing else
-- is rewritten) and drops the chunk messages' old PR `link` rows.
--
-- `process_after` is 15 minutes out (INV-67) so replicas still on the old code
-- have cut over before a chunk runs the old derivation.

INSERT INTO queue_messages (
    id,
    queue_name,
    workspace_id,
    payload,
    process_after,
    inserted_at
)
SELECT
    'queue_' || replace(gen_random_uuid()::text, '-', ''),
    'backfill.plan',
    w.id,
    jsonb_build_object(
        'workspaceId', w.id,
        'backfillName', 'stream-context-index'
    ),
    NOW() + INTERVAL '15 minutes',
    NOW()
FROM workspaces w;
