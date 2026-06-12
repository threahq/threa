-- Per-user feature flag overrides, managed from the backoffice. The flag
-- registry lives in code (@threa/types FEATURE_FLAGS): each flag declares its
-- allowed values and the first one is the default. `value` is TEXT validated
-- in code (INV-3); rows whose flag_key or value is no longer in the registry
-- are ignored at read time, so retiring a flag never needs a migration. The
-- control plane is the source of truth — changes fan out to the owning region
-- via the outbox.

CREATE TABLE feature_flag_overrides (
    workspace_id TEXT NOT NULL,
    workos_user_id TEXT NOT NULL,
    flag_key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, workos_user_id, flag_key)
);
