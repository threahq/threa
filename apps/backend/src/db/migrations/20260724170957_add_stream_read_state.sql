-- Per-user read watermark re-homed off stream_members into its own table
-- (membership ≠ access ≠ read state). Keyed by user, not member: a row is
-- user-private truth that survives membership loss. No FKs (INV-1).
CREATE TABLE IF NOT EXISTS stream_read_state (
    workspace_id       TEXT NOT NULL,        -- INV-8 ownership boundary
    stream_id          TEXT NOT NULL,
    user_id            TEXT NOT NULL,        -- NOT member_id: not a membership surface
    last_read_event_id TEXT,                 -- NULL = position before first message
    last_read_at       TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stream_id, user_id)
);

-- Bootstrap list: every read position for one user in one workspace.
CREATE INDEX IF NOT EXISTS idx_stream_read_state_workspace_user
    ON stream_read_state (workspace_id, user_id);

-- Atomic backfill of all existing watermarks. stream_members carries no
-- workspace_id, so join streams to derive it; member_id IS the user identity.
-- Only non-NULL watermarks seed a row (absence = never read, same as today).
INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
SELECT s.workspace_id, sm.stream_id, sm.member_id, sm.last_read_event_id, sm.last_read_at, NOW()
FROM stream_members sm
JOIN streams s ON s.id = sm.stream_id
WHERE sm.last_read_event_id IS NOT NULL
ON CONFLICT DO NOTHING;
