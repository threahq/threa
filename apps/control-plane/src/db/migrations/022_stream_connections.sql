-- Threa Connect: a host channel shared with any number of partner workspaces,
-- one row per invite link. The row is pending until a partner accepts it, then
-- stands for that partner's place in the channel. The control plane owns the
-- record; each region keeps projection rows, written only from the snapshots
-- the outbox fans out (revision-guarded).

CREATE TABLE stream_connections (
    id TEXT PRIMARY KEY,
    host_workspace_id TEXT NOT NULL,
    host_stream_id TEXT NOT NULL,
    host_stream_slug TEXT,
    host_stream_display_name TEXT,
    invited_by TEXT NOT NULL,
    partner_workspace_id TEXT,
    partner_visibility TEXT,
    accepted_by TEXT,
    state TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX stream_connections_stream ON stream_connections (host_stream_id, host_workspace_id);

-- A workspace joins a channel once, however many links it is sent.
CREATE UNIQUE INDEX stream_connections_active_partner
    ON stream_connections (host_workspace_id, host_stream_id, partner_workspace_id)
    WHERE state = 'active';
