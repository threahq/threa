-- Readers derive message ordinals from stream_sequences.message_ordinal, so
-- every row must carry one. Rows still NULL here are ones the
-- stream-message-ordinal backfill never counted: a database applying this
-- right after the column was added, or a workspace created after the backfill
-- was enqueued.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Every writer of message_created events holds its stream's row in this table,
-- so the lock waits out in-flight writers and blocks new ones. It must come
-- before the count: an UPDATE that waits on a row lock re-checks its WHERE
-- against the new row version but keeps the count from its original snapshot,
-- which would miss the insert it waited for.
LOCK TABLE stream_sequences IN ACCESS EXCLUSIVE MODE;

UPDATE stream_sequences q
SET message_ordinal = (
    SELECT COUNT(*)
    FROM stream_events e
    WHERE e.workspace_id = q.workspace_id
      AND e.stream_id = q.stream_id
      AND e.event_type = 'message_created'
)
WHERE q.message_ordinal IS NULL;

ALTER TABLE stream_sequences ALTER COLUMN message_ordinal SET NOT NULL;

COMMIT;
