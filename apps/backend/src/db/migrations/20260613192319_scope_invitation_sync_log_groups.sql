-- One-time rescope of pre-existing invitation entries in sync_log.
-- (sync engine v2; docs/plans/sync-v2-healing-deletion-inventory.md, the
-- `invitation:*` follow-up.)
--
-- Invitation lifecycle events carry invitee identity (email) and invite-link
-- token hashes. They are now permission-scoped to members:write holders
-- (apps/backend/src/lib/outbox/delivery-groups.ts → permission:members:write),
-- so both the live socket emit and catch-up replay reach only privileged
-- members. Entries written BEFORE that scoping deployed fell through to the
-- workspace fallback and were logged with groups = ['workspace'], so catch-up's
-- group-overlap filter (features/sync/repository.ts:listEntriesForUser) would
-- still return them — and replay their payloads — to any member, not just
-- members:write holders.
--
-- This was inert while no client read invitation events. The frontend now
-- registers an `invitation:*` handler (apps/frontend/src/sync/workspace-sync.ts),
-- so those backlog rows would deliver invitee email + token hash to a
-- non-privileged member's browser on catch-up until 30-day retention ages them
-- out (docs/plans/sync-v2-log-retention.md). Rewriting their groups to the
-- members:write permission group closes that window: the catch-up filter then
-- admits them only for holders, exactly like a post-scoping row.
--
-- Idempotent: post-scoping rows already carry ['permission:members:write'] and
-- do not match the ['workspace'] predicate, so re-running is a no-op. No FKs
-- (INV-1); workspace-scoped by table (INV-8). Runs before the server accepts
-- connections, so no outbox events are emitted. Group membership is identity,
-- not order, so rewriting groups opens no sync-id gap and owes no floor signal.

UPDATE sync_log
SET groups = ARRAY['permission:members:write']
WHERE event_type IN (
    'invitation:sent',
    'invitation:accepted',
    'invitation:revoked',
    'invitation:link-created',
    'invitation:link-claimed'
  )
  AND groups = ARRAY['workspace']::text[];
