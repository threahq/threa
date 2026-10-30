ALTER TABLE bot_invocations ALTER COLUMN source_message_id DROP NOT NULL;
ALTER TABLE agent_sessions ALTER COLUMN trigger_message_id DROP NOT NULL;
ALTER TABLE bot_invocations
  ADD COLUMN external_run_id TEXT,
  ADD COLUMN attachment_request_ids TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT bot_invocations_source_origin CHECK (
    (trigger = 'runtime-origin' AND source_message_id IS NULL AND external_run_id IS NOT NULL)
    OR (trigger <> 'runtime-origin' AND source_message_id IS NOT NULL AND external_run_id IS NULL)
  );
CREATE INDEX idx_bot_invocations_attachment_requests ON bot_invocations USING gin (attachment_request_ids)
  WHERE trigger = 'runtime-origin';
CREATE UNIQUE INDEX idx_bot_invocations_active_external_run
  ON bot_invocations (workspace_id, actor_id, target_instance_id, target_runtime_session_id, external_run_id)
  WHERE trigger = 'runtime-origin' AND status = 'claimed';
