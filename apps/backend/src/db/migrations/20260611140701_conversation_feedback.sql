-- Record user corrections of conversation membership.
--
-- When a user moves a message to a different conversation from the timeline
-- overlay, the correction is applied to the conversations table immediately
-- AND recorded here as durable ground truth. The rows are the raw material
-- for evaluating and improving the boundary extractor (which conversations
-- it splits too eagerly, especially in non-English streams).
--
-- from_conversation_id is NULL when the message had no primary conversation
-- at correction time (extraction hadn't assigned it yet, or its conversation
-- was deleted).

CREATE TABLE IF NOT EXISTS conversation_feedback (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    from_conversation_id TEXT,
    to_conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_feedback_workspace_created
    ON conversation_feedback(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_feedback_stream
    ON conversation_feedback(workspace_id, stream_id);
