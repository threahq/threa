-- =============================================================================
-- Backfill: rewrite mention/channelLink ids to authoritative actor/stream ids
-- =============================================================================
--
-- Pairs with `20260620120000_backfill_tracking.sql` (the generic backfill
-- framework's run/chunk tables). Enqueues one `backfill.plan` job per workspace;
-- the plan worker fans out small `backfill.chunk` jobs that rewrite stored
-- ProseMirror content so `mention`/`channelLink` `attrs.id` carries the resolved
-- id rather than a bare slug (INV-64). The mention-actor-refs definition is
-- idempotent, so a re-enqueue or chunk redelivery is safe.
--
-- ID shape `queue_<uuid hex>` follows the established migration-backfill
-- convention (see `20260510174647_backfill_attachment_embeddings.sql`);
-- production enqueues use ULIDs via `queueId()` in code.

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
        'backfillName', 'mention-actor-refs'
    ),
    NOW(),
    NOW()
FROM workspaces w;
