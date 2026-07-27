-- =============================================================================
-- Backfill: "In this stream" projection rows for pre-existing content
-- =============================================================================
--
-- `20260726103000_stream_context_items.sql` created the projection and the write
-- path fills it forward; everything that already existed has no rows. Enqueue one
-- `backfill.plan` job per workspace for the `stream-context-index` definition,
-- which fans out per-stream chunks (messages, memos, delegations, threads).
-- Chunks are idempotent (`ON CONFLICT DO NOTHING` on the identity index), so
-- re-enqueue and chunk redelivery are safe.
--
-- `process_after` is 15 minutes out (INV-67) so replicas still on the old code
-- have cut over before a chunk job claims a definition they don't register.

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
