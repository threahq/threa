-- Re-key feature_flag_overrides on (subject_type, subject_id) so a row can
-- describe a whole workspace, not just a user. `subject_type` is TEXT validated
-- in code (INV-3): 'workspace' rows carry the workspace id in `subject_id`,
-- 'user' rows carry the workos_user_id. `subject_id` is NOT NULL — a nullable
-- user column would let Postgres' NULLs-are-distinct rule permit duplicate
-- workspace rows. ALTER (not drop-and-recreate) is correct whether or not the
-- table is empty; existing rows backfill to the old user-scoped meaning.

ALTER TABLE feature_flag_overrides
    ADD COLUMN subject_type TEXT,
    ADD COLUMN subject_id TEXT;

UPDATE feature_flag_overrides
    SET subject_type = 'user', subject_id = workos_user_id;

ALTER TABLE feature_flag_overrides
    ALTER COLUMN subject_type SET NOT NULL,
    ALTER COLUMN subject_id SET NOT NULL;

ALTER TABLE feature_flag_overrides
    DROP CONSTRAINT feature_flag_overrides_pkey,
    ADD PRIMARY KEY (workspace_id, subject_type, subject_id, flag_key),
    DROP COLUMN workos_user_id;
