-- An org workspace exists before anyone from the org signs in, so it has no
-- creator until someone claims it.
ALTER TABLE workspace_registry ALTER COLUMN created_by_workos_user_id DROP NOT NULL;

-- One workspace per counterpart org. Ordinary workspaces keep NULL, and NULLs
-- never collide in the unique key.
ALTER TABLE workspace_registry ADD COLUMN org_key TEXT UNIQUE;
