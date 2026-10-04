-- What a workspace is: 'full' or 'connect'. The registry is the source of truth;
-- a change fans out to the workspace's region via the outbox, which mirrors it
-- onto the regional workspaces row.
ALTER TABLE workspace_registry ADD COLUMN tier TEXT NOT NULL DEFAULT 'full';
