-- Per-viewer board exclusions (board-view-design.md § "Hide & mute").
-- Two grains, deliberately separate: hide one conversation card, or mute a whole
-- stream from the board. Both are per-(user, target) state — no FK (INV-1),
-- composite PK like stream_members (INV-2 exception, no surrogate ULID), no enum
-- (INV-3), workspace_id scoped (INV-8).

CREATE TABLE IF NOT EXISTS board_hidden_conversations (
    workspace_id    TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    -- Snooze watermark: the card reappears once the conversation's
    -- last_activity_at passes hidden_at (last_activity_at is monotonic, so a
    -- genuine revival un-hides permanently). Re-hiding upserts hidden_at = NOW().
    hidden_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_board_hidden_conversations_user
    ON board_hidden_conversations (workspace_id, user_id);

CREATE TABLE IF NOT EXISTS board_muted_streams (
    workspace_id TEXT NOT NULL,
    -- The effective ROOT stream id — mute is root-grain, mirroring the board's
    -- stream scope (a thread-anchored conversation is muted via its root).
    stream_id    TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stream_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_board_muted_streams_user
    ON board_muted_streams (workspace_id, user_id);
