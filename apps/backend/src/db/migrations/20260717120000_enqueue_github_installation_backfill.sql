-- =============================================================================
-- Enqueue: backfill existing GitHub installations into the reverse index + CP routes
-- =============================================================================
--
-- Pairs with `20260716120000_workspace_integration_installation_id.sql`, which
-- only added the plaintext `installation_id` column. That column stays NULL for
-- integrations connected before it existed, so their webhooks resolve no
-- workspaces and their CP routes are never registered. This enqueues one
-- `backfill.plan` job per workspace that already holds a GitHub integration; the
-- plan worker runs the `github-installation-routes` definition (decrypt
-- credentials → set the column → upsert the CP route). Filtering to workspaces
-- with a github row keeps the enqueue tight — `plan()` is idempotent either way
-- (it no-ops for a workspace with no active github integration).
--
-- ID shape `queue_<uuid hex>` follows the established migration-backfill
-- convention (see `20260621120000_backfill_mention_actor_refs.sql`); production
-- enqueues use ULIDs via `queueId()` in code.
--
-- `process_after` is delayed 10 minutes rather than NOW() to survive a rolling
-- deploy: the `github-installation-routes` backfill definition ships in this same
-- release, so old-code replicas still draining the queue throw
-- 'Unknown backfill: github-installation-routes' and burn ~5 retries into the DLQ
-- before new code boots. A 10-minute head start lets every replica cut over first,
-- and the backfill is not latency-sensitive (it hydrates a reverse index for
-- pre-existing installs).

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
    wi.workspace_id,
    jsonb_build_object(
        'workspaceId', wi.workspace_id,
        'backfillName', 'github-installation-routes'
    ),
    NOW() + interval '10 minutes',
    NOW()
FROM (
    SELECT DISTINCT workspace_id
    FROM workspace_integrations
    WHERE provider = 'github'
) wi;
