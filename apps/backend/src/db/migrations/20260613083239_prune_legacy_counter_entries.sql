-- One-time sweep of legacy unread-counter entries from sync_log.
-- (sync engine v2; docs/plans/sync-v2-log-retention.md, "What this unblocks".)
--
-- The four unread-counter events (stream:activity, stream:read, stream:read_all,
-- activity:created) carry ABSOLUTE fields since the phase-2c backend deploy
-- (#872). Entries written before that deploy lack those fields; catch-up replay
-- of them is unsafe, so the client guard `isLegacyUnreadCounterEntry`
-- (apps/frontend/src/sync/unread-counters.ts) skips them on apply and leans on
-- the workspace bootstrap as their authority (INV-53). That guard can only be
-- deleted once no legacy entry can reach catch-up.
--
-- Pure time-based retention does not get us there reliably: a quiet workspace
-- with fewer than minKeep (2,000) lifetime sync events never trips the count
-- floor, so its legacy rows would persist indefinitely. This sweep removes them
-- directly, by CONTENT rather than a hardcoded deploy timestamp: it deletes
-- exactly the rows the guard already skips (the same per-type absent-field
-- predicate, mirrored in SQL), so it can never touch a valid post-#872 row.
--
-- Safety: the guard is client-side and the workspace sync cursor advances to
-- head with no per-sync_id contiguity check (contiguity is a separate
-- per-stream broadcastSequence mechanism, INV-61). Deleting a legacy row is
-- therefore identical to the client skipping it — surviving entries still apply
-- and the cursor still climbs to head. The deleted set is SPARSE (legacy
-- counter rows interleaved among non-counter rows), so `retained_from` is
-- deliberately NOT advanced: advancing the floor past surviving lower-id rows
-- would falsely mark them pruned and force needless bootstraps. A sparse
-- removal of skipped-anyway rows opens no gap, so no floor signal is owed.
--
-- Idempotent: re-running finds no legacy rows. No FKs (INV-1); workspace-scoped
-- by table (INV-8). Runs before the server accepts connections, so no outbox
-- events are emitted.

DELETE FROM sync_log
WHERE
  (event_type = 'stream:activity'
    AND jsonb_typeof(payload -> 'messageOrdinal') IS DISTINCT FROM 'number')
  OR (event_type = 'stream:read'
    AND jsonb_typeof(payload -> 'lastReadOrdinal') IS DISTINCT FROM 'number')
  OR (event_type = 'stream:read_all'
    AND jsonb_typeof(payload -> 'reads') IS DISTINCT FROM 'array')
  OR (event_type = 'activity:created'
    AND (jsonb_typeof(payload -> 'counts' -> 'mentionCount') IS DISTINCT FROM 'number'
      OR jsonb_typeof(payload -> 'counts' -> 'activityCount') IS DISTINCT FROM 'number'));
