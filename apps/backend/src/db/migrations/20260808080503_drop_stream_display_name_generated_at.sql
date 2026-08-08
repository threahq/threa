-- Remove timestamp naming provenance after the revision-fenced lifecycle is
-- fleet-wide. Title ownership now comes exclusively from display_name_source.

ALTER TABLE streams
DROP COLUMN IF EXISTS display_name_generated_at;
