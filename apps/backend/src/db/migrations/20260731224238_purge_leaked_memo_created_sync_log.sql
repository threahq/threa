-- Drop the `memo:created` tail from the sync log.
--
-- Until this deploy the event was workspace-group routed and carried the whole
-- memo (title, abstract, key points, tags). Every one of those payloads was
-- copied into `sync_log`, which replays to any member on catch-up for weeks and
-- does NOT access-check workspace-group entries — so the retained log holds
-- every workspace member a readable copy of memos extracted from streams they
-- cannot open. Fixing the emitter stops new rows; these are the ones already
-- written.
--
-- Deleted rather than re-scoped: the event is a pure cache-invalidation signal
-- (the client only invalidates its memo searches), so a replay that never
-- arrives costs nothing the explorer's own bootstrap doesn't already cover.
-- Deleting mid-range sync ids is safe — heads come from
-- `workspace_sync_sequences`, not from the log, and catch-up returns entries
-- after a cursor rather than requiring a dense run.

DELETE FROM sync_log WHERE event_type = 'memo:created';
