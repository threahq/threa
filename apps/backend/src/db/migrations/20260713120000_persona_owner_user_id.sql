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
-- owner_user_id = NULL and satisfy the CHECK unchanged. The shared
-- UNIQUE (workspace_id, slug) is intentionally untouched — personal personas
-- share the workspace slug namespace so mention resolution stays deterministic.
ALTER TABLE personas ADD COLUMN owner_user_id TEXT;

ALTER TABLE personas ADD CONSTRAINT personas_owner_user_id_shape CHECK (
    (managed_by <> 'user' AND owner_user_id IS NULL) OR
    (managed_by = 'user' AND owner_user_id IS NOT NULL)
);

-- Lookup index for the per-user personal persona list (bootstrap + visibility
-- reads scope by (workspace_id, owner_user_id)).
CREATE INDEX idx_personas_workspace_owner
    ON personas (workspace_id, owner_user_id)
    WHERE owner_user_id IS NOT NULL;
