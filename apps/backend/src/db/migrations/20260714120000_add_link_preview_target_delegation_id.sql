-- Add a target reference column for in-app delegation link previews.
-- Populated only when content_type = 'delegation_link'; NULL for every other preview.
-- No foreign keys per INV-1.

ALTER TABLE link_previews ADD COLUMN target_delegation_id TEXT;
