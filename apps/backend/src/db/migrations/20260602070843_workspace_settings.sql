-- =============================================================================
-- Workspace Setting Overrides
-- Sparse key-value storage for workspace-wide settings (e.g. the default
-- working schedule members inherit). Mirrors user_preference_overrides: only
-- values that differ from code-defined defaults are stored, so changing a
-- default is a code deploy rather than a data migration.
-- =============================================================================

CREATE TABLE workspace_setting_overrides (
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,              -- e.g., "defaultWorkSchedule"
    value JSONB NOT NULL,           -- The override value (any JSON type)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (workspace_id, key)
);
