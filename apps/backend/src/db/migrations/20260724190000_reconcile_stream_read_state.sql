-- Post-drain reconciliation of membership watermarks into stream_read_state.
--
-- DEPLOYMENT ORDERING: this runs when PR 2 (read cutover) deploys. PR 1
-- (20260724170957_add_stream_read_state.sql — table + initial backfill) must
-- have deployed FIRST and all pre-PR-1 binaries must have DRAINED before this
-- migration runs. PR 1's backfill copied every then-existing membership
-- watermark, and PR 1 binaries dual-write on every watermark move; old
-- binaries still running between that backfill and drain wrote the membership
-- column ONLY. This statement folds those late membership-only writes into
-- the standalone table, closing the rolling-deploy window. Running it before
-- drain would leave a gap the next old-binary write reopens.
--
-- Rules (mirror ReadStateRepository.advance):
--   * workspace_id derived through streams (INV-8), membership watermark
--     bound to its stream;
--   * insert rows the initial backfill never saw (membership-only watermarks);
--   * on conflict advance ONLY when the membership watermark's event sequence
--     is STRICTLY greater than the standalone watermark's sequence — NULL or
--     unresolvable watermarks count as sequence 0 (before the first message);
--   * never regress standalone state: an explicit mark-unread may have moved
--     it below the membership mirror on purpose, so equality loses too;
--   * last_read_at carries over only when the membership frontier wins.

INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
SELECT s.workspace_id, sm.stream_id, sm.member_id, sm.last_read_event_id, sm.last_read_at, NOW()
FROM stream_members sm
JOIN streams s ON s.id = sm.stream_id
WHERE sm.last_read_event_id IS NOT NULL
ON CONFLICT (stream_id, user_id) DO UPDATE
SET last_read_event_id = EXCLUDED.last_read_event_id,
    last_read_at = EXCLUDED.last_read_at,
    updated_at = NOW()
WHERE COALESCE(
    (SELECT mem_ev.sequence FROM stream_events mem_ev
       WHERE mem_ev.id = EXCLUDED.last_read_event_id AND mem_ev.stream_id = EXCLUDED.stream_id),
    0
  ) > COALESCE(
    (SELECT cur_ev.sequence FROM stream_events cur_ev
       WHERE cur_ev.id = stream_read_state.last_read_event_id AND cur_ev.stream_id = stream_read_state.stream_id),
    0
  );
