SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX idx_sca_stream_intent_unique_ws ON stream_context_attachments (workspace_id, stream_id, intent);
