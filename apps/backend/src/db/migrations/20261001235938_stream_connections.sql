-- Threa Connect: this region's view of a shared channel, one row per connection
-- for each workspace here that takes part in it: the host, the connection's
-- partner, or a peer (another partner in the same channel). Written only from
-- control-plane snapshots, and only when the snapshot's revision is newer than
-- the stored one (INV-66).
CREATE TABLE stream_connections (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    stream_slug TEXT,
    stream_display_name TEXT,
    remote_workspace_id TEXT,
    remote_workspace_name TEXT,
    partner_visibility TEXT,
    invited_by TEXT,
    accepted_by TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revision INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, id)
);

CREATE INDEX stream_connections_stream ON stream_connections (workspace_id, stream_id);
