-- Multi-installation support for GitHub: N rows per (workspace, provider), one
-- per installation. The old single-row unique index (workspace_id, provider) is
-- replaced by two partial indexes:
--   1. (workspace_id, provider, installation_id) WHERE installation_id IS NOT NULL
--      lets a workspace hold many GitHub installs (org + personal + more), each a
--      distinct row keyed by its installation id, while still rejecting a
--      duplicate row for the same installation.
--   2. (workspace_id, provider) WHERE installation_id IS NULL keeps at most one
--      NULL-installation row per (workspace, provider) — legacy GitHub rows that
--      predate the installation_id backfill, and any provider that never sets an
--      installation id.
-- Linear is single-row but NOT covered by index #2: it stores its org id in
-- installation_id (non-null), so its rows fall under index #1. Index #1 alone
-- would permit a second Linear row per distinct org id, so Linear's single-row
-- guarantee is enforced at the app layer by an id-keyed upsert (ON CONFLICT (id))
-- that rewrites the one row on an org switch — see persistLinearCredentials.
-- Partial indexes are used rather than NULLS NOT DISTINCT because that clause is
-- unavailable on older PostgreSQL and partial indexes work everywhere.
--
-- Deploy-window note: the new indexes are created BEFORE the old one is dropped,
-- so uniqueness is never unenforced. Between this migration and the code cutover
-- an old replica still runs `ON CONFLICT (workspace_id, provider)`, which errors
-- once the backing index is gone; the blast radius is an admin connecting a new
-- install mid-deploy (a retryable 500). Token refreshes are UPDATEs and are
-- unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_workspace_provider_installation
    ON workspace_integrations (workspace_id, provider, installation_id)
    WHERE installation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_workspace_provider_no_installation
    ON workspace_integrations (workspace_id, provider)
    WHERE installation_id IS NULL;

DROP INDEX IF EXISTS workspace_integrations_workspace_provider;
