-- =============================================================================
-- Backfill: "In this stream" projection rows for pre-existing follow-ups
-- =============================================================================
--
-- The write path now projects a `follow_up` row at schedule time; every
-- follow-up scheduled before it has none. Re-enqueue one `backfill.plan` job per
-- workspace for the SAME `stream-context-index` definition — the plan now also
-- fans out a `follow_ups` chunk per stream that has rows. A new name would throw
-- `Unknown backfill` into the DLQ. Chunks are idempotent (`ON CONFLICT DO
-- NOTHING` on the identity index), so re-running the whole definition rewrites
-- nothing that already exists.
--
-- `process_after` is 15 minutes out (INV-67) so replicas still on the old code
-- have cut over before a chunk job claims a chunk kind they don't handle.

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
