-- Event-anchored threads (cleanup, Phase 2): drop the grace-period legacy shapes.
--
-- The substrate migration (20260721120000) added `parent_anchor_id` and moved
-- reply stats onto the thread stream row, keeping `streams.parent_message_id`,
-- its unique index, and `messages.reply_count` alive so old-deploy replicas
-- stayed correct during the rollout. All code now reads/writes only the anchor
-- track, so the legacy columns are dead.
--
-- DEPLOY WINDOW (honest): this migration runs at new-instance boot, before the
-- new code serves. The replica it breaks is the IMMEDIATE chunk-6 predecessor,
-- not some hypothetical old-old build: chunk-6 `SELECT_FIELDS` still selects
-- `streams.parent_message_id`, every message SELECT still lists
-- `messages.reply_count`, and `scheduled_messages` reads still name
-- `parent_message_id` — so from the moment this boots until the last chunk-6
-- replica drains, those replicas error API-wide. Shipping the DROP in the same
-- PR as the reading code is the correct mechanic (new code never sees the old
-- schema); the residual chunk-6 error window is inherent to a boot-time DROP.
-- Merge during a quiet window (or split the DROPs into their own delayed phase
-- if a zero-error overlap is required).

-- RECONCILE before dropping (idempotent). The substrate backfill ran ONCE; a
-- still-serving pre-stack replica could, afterward, (a) create a thread writing
-- only `parent_message_id` (leaving `parent_anchor_id` NULL) or (b) add/delete
-- replies bumping only `messages.reply_count` (leaving `streams.reply_count`
-- skewed). Dropping the legacy columns without repairing those intervening
-- writes would orphan such threads (unfindable by anchor) and freeze stale
-- counts. Repeat both backfills so no straggler row is lost.

-- (a) Coalesce any legacy-only anchor onto the canonical column.
UPDATE streams
SET parent_anchor_id = parent_message_id
WHERE type = 'thread' AND parent_anchor_id IS NULL AND parent_message_id IS NOT NULL;

-- (b) Recompute reply stats authoritatively from each thread stream's own live
-- messages (the thread IS the stream its replies land in). LEFT JOIN so threads
-- whose replies were all deleted reset to 0 / NULL.
UPDATE streams s
SET reply_count = stats.reply_count,
    last_reply_at = stats.last_reply_at
FROM (
  SELECT t.id AS stream_id,
         COUNT(m.id) AS reply_count,
         MAX(m.created_at) AS last_reply_at
  FROM streams t
  LEFT JOIN messages m ON m.stream_id = t.id AND m.deleted_at IS NULL
  WHERE t.type = 'thread'
  GROUP BY t.id
) stats
WHERE s.id = stats.stream_id;

-- The rolling-deploy bridge is no longer needed once predecessor replicas have
-- drained. Remove it before the companion migration drops messages.reply_count.
DROP TRIGGER IF EXISTS sync_legacy_message_thread_projection ON messages;
DROP FUNCTION IF EXISTS sync_legacy_message_thread_projection();

-- Companion migrations drop the legacy index concurrently, then remove the
-- columns it protected. Keeping the index operation standalone avoids holding a
-- write-blocking streams lock for the duration of the index drop.
