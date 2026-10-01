-- Threa Connect: one host channel shared with one partner workspace. The
-- control plane owns the record; each side's region keeps a projection row,
-- written only from the snapshots the outbox fans out (revision-guarded).

CREATE TABLE stream_connections (
    id TEXT PRIMARY KEY,
    host_workspace_id TEXT NOT NULL,
    host_stream_id TEXT NOT NULL,
    host_stream_slug TEXT,
    host_stream_display_name TEXT,
    partner_workspace_id TEXT,
    partner_visibility TEXT,
    state TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A channel has at most one live connection: a pending invite or an accepted share.
CREATE UNIQUE INDEX stream_connections_live_per_stream
    ON stream_connections (host_workspace_id, host_stream_id)
    WHERE state IN ('invited', 'active');
