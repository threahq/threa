-- Mirror of the control plane's workspace_registry.tier ('full' or 'connect'),
-- pushed by the control plane. Every workspace created before the tier existed is 'full'.
ALTER TABLE workspaces ADD COLUMN tier TEXT NOT NULL DEFAULT 'full';
