-- messages.revision itself landed in 20260821120000_messages_revision.sql.
-- Deletion is a canonical source mutation just like an edit. Historical
-- tombstones therefore consume one revision even though the legacy delete path
-- did not write a message_versions row.
UPDATE messages
SET revision = revision + 1
WHERE deleted_at IS NOT NULL;

ALTER TABLE bot_invocations
  ADD COLUMN source_message_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN claimed_source_message_revision INTEGER,
  ADD COLUMN claimed_input_update_mode TEXT,
  ADD COLUMN cancellation_reason TEXT;

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

CREATE INDEX idx_bot_invocations_active_source_cancellation
  ON bot_invocations (workspace_id, actor_id, source_message_id)
  WHERE status IN ('pending', 'claimed');
