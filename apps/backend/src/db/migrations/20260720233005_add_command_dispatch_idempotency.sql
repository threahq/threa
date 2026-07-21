CREATE TABLE IF NOT EXISTS command_dispatches (
    command_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    client_command_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS command_dispatches_client_id_unique
    ON command_dispatches (workspace_id, user_id, stream_id, client_command_id);
