-- =============================================================================
-- Backfill: pin legacy quote / share nodes to a source revision and range
-- =============================================================================
--
-- Pairs with `20260620120000_backfill_tracking.sql` (the generic backfill
-- framework's run/chunk tables). Enqueues one `backfill.plan` job per workspace;
-- the plan worker fans out small `backfill.chunk` jobs that pin stored
-- ProseMirror `quoteReply` / `sharedMessage` nodes written before the server
-- resolved references: a quote gets the revision its stored snippet was taken
-- from plus the span it covers, a share gets its source's current revision.
-- The message-reference-pins definition is idempotent (a pinned node is
-- skipped), so a re-enqueue or chunk redelivery is safe.
--
-- `process_after` is delayed 10 minutes (INV-67) so every replica is running the
-- code that registers the definition before the first plan job is claimed.
--
-- ID shape `queue_<uuid hex>` follows the established migration-backfill
-- convention (see `20260621120000_backfill_mention_actor_refs.sql`);
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
        'backfillName', 'message-reference-pins'
    ),
    NOW() + INTERVAL '10 minutes',
    NOW()
FROM workspaces w;
