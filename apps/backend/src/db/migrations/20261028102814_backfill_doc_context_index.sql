-- =============================================================================
-- Backfill: "In this stream" doc rows
-- =============================================================================
--
-- The write path now projects a `doc` row on a doc's host when the doc is
-- created, and one per doc chip in a message body. Re-enqueue the SAME
-- `stream-context-index` definition per workspace: the plan now fans out a
-- `docs` chunk per host stream, and messages chunks derive doc-chip rows. Chunks
-- are idempotent (`ON CONFLICT DO NOTHING` on the identity index), so nothing
-- that already exists is rewritten. Only workspaces holding a doc are
-- enqueued: without one there is no hosted row or chip to rebuild, and the
-- re-plan rescans every message.
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
FROM workspaces w
WHERE EXISTS (
    SELECT 1 FROM streams s WHERE s.workspace_id = w.id AND s.type = 'doc'
);
