-- Threa Connect: a partner workspace's copy of a shared channel keeps the host's
-- ids, so its streams and the people who write in it name the workspace they
-- were copied from. NULL is an ordinary local row.
ALTER TABLE streams ADD COLUMN origin_workspace_id TEXT;
ALTER TABLE users ADD COLUMN origin_workspace_id TEXT;

-- How far a partner workspace has applied each stream of a shared tree: the
-- host's stream event sequence it has applied through, advanced in the same
-- transaction as the rows it applied.
CREATE TABLE stream_connection_cursors (
    workspace_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    host_sequence BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, connection_id, stream_id)
);
