-- Mirror of the control plane: an org workspace has no creator until someone
-- from the org claims it.
ALTER TABLE workspaces ALTER COLUMN created_by DROP NOT NULL;

-- The workspace user standing in for a person known by an external identity
-- (provider, team, user), so a repeat share maps them to the same user.
CREATE TABLE user_external_identities (
    workspace_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_team_id TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, provider, external_team_id, external_user_id)
);
