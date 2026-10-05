-- Threa Connect: a partner's copy of a memo its host captured from a shared
-- channel keeps the host's id and names the workspace it came from. NULL is a
-- memo this workspace made itself.
ALTER TABLE memos ADD COLUMN origin_workspace_id TEXT;
