-- Append-only revision history for persona (built-in agent) config overrides
-- (roadmap 7.1 history). Every accepted `setOverride` — including a restore —
-- appends one row capturing the sparse `patch` committed at that `version`, so
-- admins can view previous revisions and roll back to any of them (a rollback
-- re-commits the old patch as a NEW revision; history is never destructive).
--
-- Mirrors `stream_brief_revisions`, but with a read+restore surface on top (brief
-- revisions are write-only). `patch` is JSONB (the same sparse editable-field
-- shape stored in `agent_config_overrides.patch`, validated in app code via the
-- shared schema — INV-3 no DB enums, INV-1 no FKs). `version` is monotonic per
-- `(workspace_id, agent_id)`, derived race-safely inside the override txn whose
-- row lock serializes concurrent writers (INV-20). `created_by_kind` is
-- `user`|`persona` (validated in code, INV-3). Workspace-scoped (INV-8).
CREATE TABLE IF NOT EXISTS persona_config_revisions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    version INT NOT NULL,
    patch JSONB NOT NULL,
    created_by_kind TEXT NOT NULL,
    created_by_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The history list reads newest-first for one persona in a workspace.
CREATE INDEX IF NOT EXISTS idx_persona_config_revisions_agent
    ON persona_config_revisions (workspace_id, agent_id, version DESC);
