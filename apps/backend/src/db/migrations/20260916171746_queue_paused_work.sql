ALTER TABLE queue_messages
  ADD COLUMN IF NOT EXISTS paused_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_queue_messages_paused_workspace
  ON queue_messages (workspace_id)
  WHERE paused_reason IS NOT NULL;
