-- Integration webhook routing table. GitHub delivers one webhook per app
-- installation; the control plane resolves an installation id to the set of
-- regions that host workspaces subscribed to it, then fans one dispatch event
-- per region. Workspace resolution stays regional (INV-8) — CP only maps
-- external_id -> region here.
--
-- installation_id is NOT a secret (it rides in every webhook payload), so it is
-- stored plaintext. A workspace lives in exactly one region, so (provider,
-- external_id, workspace_id) is the natural upsert key; region is a column that
-- follows the workspace. No FKs (INV-1), no enums (INV-3).

CREATE TABLE integration_routes (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    region TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, external_id, workspace_id)
);

CREATE INDEX idx_integration_routes_provider_external
    ON integration_routes (provider, external_id);
