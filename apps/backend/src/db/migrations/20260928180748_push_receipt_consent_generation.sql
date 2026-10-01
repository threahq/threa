-- Consent lineage for automatic push receipts.
--
-- value_generation: identifies one value of one preference override. A single
-- global sequence, so a deleted override that is inserted again (reset, then
-- re-grant) never gets a number it had before. Trigger-owned: every writer,
-- including replicas that predate this column, gets a fresh number when it
-- inserts a row or changes its value, and keeps the number on a write that
-- leaves the value as it was. Existing rows each take their own number when
-- the column is added.
CREATE SEQUENCE IF NOT EXISTS user_preference_override_generation_seq;

ALTER TABLE user_preference_overrides
  ADD COLUMN IF NOT EXISTS value_generation BIGINT NOT NULL DEFAULT nextval('user_preference_override_generation_seq');

CREATE OR REPLACE FUNCTION advance_user_preference_override_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.user_id, OLD.key, OLD.value) IS NOT DISTINCT FROM (NEW.user_id, NEW.key, NEW.value) THEN
    NEW.value_generation := OLD.value_generation;
  ELSE
    NEW.value_generation := nextval('user_preference_override_generation_seq');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS advance_user_preference_override_generation ON user_preference_overrides;
CREATE TRIGGER advance_user_preference_override_generation
BEFORE INSERT OR UPDATE ON user_preference_overrides
FOR EACH ROW
EXECUTE FUNCTION advance_user_preference_override_generation();

-- The analytics consent grant (its override's value_generation) an automatic
-- receipt was armed under. Ingest and monitoring accept the receipt only while
-- that same grant is still the current one, so a withdrawal, reset or re-grant
-- ends it whether or not the device reported in between. NULL (test receipts,
-- or a delivery row armed before this column) never matches a grant.
ALTER TABLE push_receipts ADD COLUMN IF NOT EXISTS consent_generation BIGINT;
