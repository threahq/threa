-- =============================================================================
-- Re-enqueue the two backfills whose plan queries scoped `messages` by a column
-- it does not have
-- =============================================================================
--
-- `messages` carries no `workspace_id`; it scopes through its stream. Both
-- `stream-context-index` and `mention-actor-refs` planned with
-- `WHERE workspace_id = $1` against it, so every plan job threw
-- `column "workspace_id" does not exist` and dead-lettered before fanning out a
-- single chunk. The symptom for stream-context was an empty "In this stream"
-- panel for all pre-existing content while live writes kept indexing correctly.
--
-- The queries now scope through `streams`, so this re-enqueues both. Chunks are
-- idempotent (`ON CONFLICT DO NOTHING` on the identity index for stream-context;
-- a no-op rewrite for mentions), so overlapping with rows the live path already
-- wrote is safe. The original dead-lettered jobs stay where they are — they
-- carry no state worth recovering.
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
        'backfillName', name.value
    ),
    NOW() + INTERVAL '15 minutes',
    NOW()
FROM workspaces w
CROSS JOIN (VALUES ('stream-context-index'), ('mention-actor-refs')) AS name(value);
