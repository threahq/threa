-- Subject-keyed regional mirror of feature-flag overrides. Replaces the
-- per-user `user_feature_flags` table so a flag can be attached to a whole
-- workspace (subject_type='workspace', subject_id=workspace_id) or to one user
-- (subject_type='user', subject_id=workos_user_id). Source of truth is the
-- control plane, pushed here via POST /internal/feature-flags as one subject's
-- raw overrides; the region stores each layer and resolves against the code
-- registry (@threa/types FEATURE_FLAGS) at read time, so retired keys/values
-- and undeclared scopes drop with no migration (INV-3: TEXT + code validation).
--
-- subject_id is NOT NULL and carries the workspace_id for workspace rows: a
-- nullable user column would let Postgres' NULLs-are-distinct rule admit
-- duplicate workspace rows for the same flag.
--
-- User rows key on workos_user_id, not the regional user_id (decision 2): the
-- CP no longer has to resolve a regional user before writing, so a flag set for
-- an invited-but-never-signed-in user is stored instead of silently dropped.

CREATE TABLE feature_flag_overrides (
    workspace_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,   -- 'workspace' | 'user' (code-validated, INV-3)
    subject_id   TEXT NOT NULL,   -- workos_user_id, or workspace_id for workspace scope
    flag_key     TEXT NOT NULL,
    value        TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, subject_type, subject_id, flag_key)
);

-- Safe drop. The table is NOT provably empty — retired flags (board-view,
-- sync-v2-cursor) were live per-user rollouts while it existed, and retirement
-- only removes the registry entry, never the rows. But any surviving rows are
-- overrides for keys no longer in FEATURE_FLAGS, so they are already inert (read
-- paths filter through the registry) — nothing live reads them. They were also
-- keyed by the regional user_id this design abandons for workos_user_id, so a
-- backfill would carry nothing forward. Dropping removes latent stale rows and
-- the CP re-populates the new table by sync.
DROP TABLE user_feature_flags;
