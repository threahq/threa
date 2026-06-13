-- Regional mirror of control-plane platform-admin grants (platform_roles).
-- Presence of a row = this workspace user is a platform admin and may see
-- links into the backoffice (admin.threa.io). Keyed by workos_user_id rather
-- than the regional users.id so a sync can land independently of regional
-- user provisioning order. Populated only by the control-plane fan-out via
-- POST /internal/platform-admin; never written by regional product code.

CREATE TABLE IF NOT EXISTS platform_admin_access (
    workspace_id TEXT NOT NULL,
    workos_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, workos_user_id)
);
