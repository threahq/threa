ALTER TABLE messages
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

UPDATE messages m
SET revision = 1 + versions.version_count
FROM (
  SELECT message_id, COUNT(*)::integer AS version_count
  FROM message_versions
  GROUP BY message_id
) versions
WHERE versions.message_id = m.id;

ALTER TABLE bot_invocations
  ADD COLUMN source_message_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN claimed_source_message_revision INTEGER,
  ADD COLUMN claimed_input_update_mode TEXT,
  ADD COLUMN cancellation_reason TEXT,
  ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE bot_invocations i
SET source_message_revision = m.revision
FROM messages m
JOIN streams s ON s.id = m.stream_id
WHERE i.source_message_id = m.id
  AND i.workspace_id = s.workspace_id;

UPDATE bot_invocations i
SET status = 'cancelled',
    cancellation_reason = 'source_deleted',
    updated_at = NOW()
FROM messages m
JOIN streams s ON s.id = m.stream_id
WHERE i.source_message_id = m.id
  AND i.workspace_id = s.workspace_id
  AND m.deleted_at IS NOT NULL
  AND i.status IN ('pending', 'claimed');

UPDATE bot_invocations
SET claimed_source_message_revision = source_message_revision
WHERE status = 'claimed'
  AND claimed_source_message_revision IS NULL;

ALTER TABLE bot_invocations
  DROP CONSTRAINT bot_invocations_workspace_id_source_message_id_actor_type_a_key;

CREATE UNIQUE INDEX idx_bot_invocations_active_source_actor_trigger
  ON bot_invocations (workspace_id, source_message_id, actor_type, actor_id, trigger)
  WHERE status IN ('pending', 'claimed');
