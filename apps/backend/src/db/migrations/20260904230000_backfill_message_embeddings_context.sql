-- =============================================================================
-- Backfill: re-embed existing messages with stream/anchor/preceding context
-- =============================================================================
--
-- Activates the "message-embeddings-context" backfill definition
-- (`registerMessageEmbeddingBackfill`, apps/backend/src/features/memos/message-embedding-backfill.ts):
-- rows embedded before this release hold bare-content vectors; this re-embeds
-- them through the same `loadMessageEmbeddingText` builder the live path uses.
-- Enqueues one `backfill.plan` job per workspace; `process_after` is delayed
-- 15 minutes so a rolling deploy's old-code replicas cut over before any
-- chunk job can claim "Unknown backfill" (INV-67).

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
        'backfillName', 'message-embeddings-context'
    ),
    NOW() + interval '15 minutes',
    NOW()
FROM workspaces w;
