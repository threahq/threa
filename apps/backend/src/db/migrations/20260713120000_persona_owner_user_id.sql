-- Personal personas (user-scoped-personas step 1). A member can fork a persona
-- that only they see and invoke, living in their own scratchpads. Mirrors the
-- personal-bots precedent (20260507182654_bots_type_owner_traits.sql): a new
-- `managed_by = 'user'` discriminator plus an owner reference.
--
-- Shape invariant (a consistency constraint, not a DB enum — INV-1/INV-3;
-- `managed_by` values stay validated in application code):
--   (managed_by <> 'user'  AND owner_user_id IS NULL) OR
--   (managed_by  = 'user'  AND owner_user_id IS NOT NULL)
--
-- Existing rows are system/workspace personas, so they backfill to
-- owner_user_id = NULL and satisfy the CHECK unchanged.
--
-- Slug namespace (Kris's post-review ruling): personal personas get a PER-OWNER
-- slug namespace, not the shared workspace one. One member trying a name must
-- never force `-2` suffixes onto everyone who copies it. So the core-schema
-- table-level UNIQUE (workspace_id, slug) is replaced here by two partial unique
-- indexes: shared rows (system + workspace) keep the workspace-wide namespace;
-- personal rows are unique only per (workspace, owner). Safe because mentions are
-- id-authoritative (INV-64, `[@slug](persona:persona_x)`) — the slug is a display
-- label, and same-slug rows disambiguate by id at resolution time.
ALTER TABLE personas ADD COLUMN owner_user_id TEXT;

ALTER TABLE personas ADD CONSTRAINT personas_owner_user_id_shape CHECK (
    (managed_by <> 'user' AND owner_user_id IS NULL) OR
    (managed_by = 'user' AND owner_user_id IS NOT NULL)
);

-- Drop the shared table-level UNIQUE (workspace_id, slug) (auto-named by
-- Postgres). Its NULL-workspace semantics (system rows, workspace_id IS NULL,
-- were never mutually unique because NULLs are distinct) are preserved by the
-- partial index below, which keeps the same (workspace_id, slug) shape.
ALTER TABLE personas DROP CONSTRAINT personas_workspace_id_slug_key;

-- Shared namespace: system (workspace_id IS NULL) + workspace customs share one
-- (workspace_id, slug) space, exactly as the dropped constraint did. Partial so
-- personal rows are excluded. A UNIQUE INDEX (not a constraint) because a
-- constraint cannot carry a WHERE predicate.
CREATE UNIQUE INDEX personas_shared_slug_key
    ON personas (workspace_id, slug)
    WHERE managed_by <> 'user';

-- Personal namespace: a personal (`managed_by = 'user'`) slug is unique only
-- within one (workspace, owner). Two members can both hold 'coach'; a member and
-- a workspace custom can both hold 'coach'; the same member cannot hold 'coach'
-- twice. owner_user_id is NOT NULL for these rows (the shape CHECK), so no NULL
-- distinctness applies here. This index also serves the per-user personal-list
-- lookup via its (workspace_id, owner_user_id) leftmost prefix.
CREATE UNIQUE INDEX personas_personal_slug_key
    ON personas (workspace_id, owner_user_id, slug)
    WHERE managed_by = 'user';
