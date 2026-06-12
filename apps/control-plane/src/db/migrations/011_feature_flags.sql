-- Per-user feature flag overrides, managed from the backoffice. The flag key
-- registry lives in code (@threa/types FEATURE_FLAG_KEYS); rows whose flag_key
-- is no longer in the registry are ignored at read time, so retiring a flag
-- never needs a migration. The control plane is the source of truth — changes
-- fan out to the owning region via the outbox.

CREATE TABLE feature_flag_overrides (
    workspace_id TEXT NOT NULL,
    workos_user_id TEXT NOT NULL,
    flag_key TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, workos_user_id, flag_key)
);
