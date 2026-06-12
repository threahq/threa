-- Regional mirror of per-user feature flags. Source of truth is the control
-- plane (feature_flag_overrides), pushed here via POST /internal/feature-flags
-- as a full per-user snapshot. The flag key registry lives in code
-- (@threa/types FEATURE_FLAG_KEYS); rows for retired keys are ignored at read
-- time, so deleting a flag never needs a migration.

CREATE TABLE user_feature_flags (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    flag_key TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id, flag_key)
);
