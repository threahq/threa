-- =============================================================================
-- Sidebar Configs
-- One row per (workspace, user) holding the viewer's sidebar layout as a single
-- JSON document (basePreset + ordered sections). Absent row = code-defined
-- default (the Smart preset), so changing the default is a code deploy, not a
-- migration. No FKs (INV-1), no enums (INV-3), workspace-scoped (INV-8).
-- =============================================================================

CREATE TABLE sidebar_configs (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    config JSONB NOT NULL,          -- Full SidebarConfig document
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (workspace_id, user_id)
);
